from __future__ import annotations

from dataclasses import dataclass
from typing import Any
import json
import os
import socket
import sqlite3
import time
from urllib import request, error

from .db import fetch_cloud_queue_batch, mark_cloud_payload_uploaded


@dataclass(frozen=True)
class CloudSettings:
    api_url: str
    token: str
    employee_email: str
    company_domain: str
    device_key: str
    upload_interval_seconds: int
    max_queue_batch_size: int = 25
    queue_drain_pause_seconds: float = 0.25
    max_queue_rows: int = 25000
    max_queue_bytes: int = 268435456


@dataclass(frozen=True)
class QueueDrainResult:
    attempted: int
    uploaded: int
    failed: int
    remaining: int


def _os_user() -> str:
    return os.environ.get('USER') or os.environ.get('USERNAME') or 'unknown'


def load_cloud_settings() -> CloudSettings | None:
    api_url = os.environ.get('EMPLOYEE_TRACKER_CLOUD_API', '').strip()
    token = os.environ.get('EMPLOYEE_TRACKER_ENROLLMENT_TOKEN') or os.environ.get('EMPLOYEE_TRACKER_INGEST_KEY', '')
    employee_email = os.environ.get('EMPLOYEE_TRACKER_EMPLOYEE_EMAIL', '').strip().lower()
    company_domain = os.environ.get('EMPLOYEE_TRACKER_COMPANY_DOMAIN', 'neodym.ai').strip().lower()
    if not api_url or not token or not employee_email:
        return None
    host = socket.gethostname()
    os_user = _os_user()
    device_key = os.environ.get('EMPLOYEE_TRACKER_DEVICE_KEY', f'{employee_email}:{host}:{os_user}').strip()
    upload_interval = int(os.environ.get('EMPLOYEE_TRACKER_CLOUD_UPLOAD_SECONDS', '5'))
    batch_size = int(os.environ.get('EMPLOYEE_TRACKER_UPLOAD_BATCH_SIZE', '25'))
    drain_pause = float(os.environ.get('EMPLOYEE_TRACKER_UPLOAD_BATCH_PAUSE_SECONDS', '0.25'))
    max_queue_rows = int(os.environ.get('EMPLOYEE_TRACKER_MAX_UPLOAD_QUEUE_ROWS', '5000'))
    max_queue_bytes = int(os.environ.get('EMPLOYEE_TRACKER_MAX_UPLOAD_QUEUE_BYTES', str(64 * 1024 * 1024)))
    return CloudSettings(
        api_url=api_url,
        token=token.strip(),
        employee_email=employee_email,
        company_domain=company_domain,
        device_key=device_key,
        upload_interval_seconds=max(1, upload_interval),
        max_queue_batch_size=max(1, batch_size),
        queue_drain_pause_seconds=max(0.0, drain_pause),
        max_queue_rows=max(100, max_queue_rows),
        max_queue_bytes=max(1024 * 1024, max_queue_bytes),
    )


class CloudUploader:
    def __init__(self, settings: CloudSettings | None) -> None:
        self.settings = settings
        self._last_upload_at = 0.0
        self._last_error_at = 0.0

    @property
    def enabled(self) -> bool:
        return self.settings is not None

    def maybe_upload_activity(self, payload: dict[str, Any]) -> bool:
        if self.settings is None:
            return False
        now = time.time()
        if (now - self._last_upload_at) < self.settings.upload_interval_seconds:
            return False
        self._last_upload_at = now
        return self.upload_activity(payload)

    def drain_queue(self, connection: sqlite3.Connection) -> QueueDrainResult:
        if self.settings is None:
            return QueueDrainResult(attempted=0, uploaded=0, failed=0, remaining=0)
        now = time.time()
        if (now - self._last_upload_at) < self.settings.upload_interval_seconds:
            rows = fetch_cloud_queue_batch(connection, limit=1)
            return QueueDrainResult(attempted=0, uploaded=0, failed=0, remaining=len(rows))
        self._last_upload_at = now
        rows = fetch_cloud_queue_batch(connection, limit=self.settings.max_queue_batch_size)
        uploaded = 0
        failed = 0
        for index, row in enumerate(rows):
            try:
                payload = json.loads(row['payload_json'])
            except (TypeError, json.JSONDecodeError):
                mark_cloud_payload_uploaded(connection, row['id'])
                uploaded += 1
                continue
            if self.upload_activity(payload):
                mark_cloud_payload_uploaded(connection, row['id'])
                uploaded += 1
                if self.settings.queue_drain_pause_seconds and index < len(rows) - 1:
                    time.sleep(self.settings.queue_drain_pause_seconds)
            else:
                failed += 1
                break
        remaining = max(0, len(fetch_cloud_queue_batch(connection, limit=self.settings.max_queue_batch_size + 1)))
        return QueueDrainResult(attempted=len(rows), uploaded=uploaded, failed=failed, remaining=remaining)

    def upload_activity(self, payload: dict[str, Any]) -> bool:
        if self.settings is None:
            return False
        body = dict(payload)
        body.setdefault('employee_email', self.settings.employee_email)
        body.setdefault('company_domain', self.settings.company_domain)
        body.setdefault('device_key', self.settings.device_key)
        body.setdefault('hostname', socket.gethostname())
        body.setdefault('os_user', _os_user())
        body.setdefault('event_type', 'activity_snapshot')
        data = json.dumps(body, default=str).encode('utf-8')
        req = request.Request(
            self.settings.api_url,
            data=data,
            method='POST',
            headers={
                'content-type': 'application/json',
                'x-enrollment-token': self.settings.token,
                # Backward-compatible with the current shared-key endpoint.
                'x-ingest-key': self.settings.token,
            },
        )
        try:
            with request.urlopen(req, timeout=10) as response:
                response.read(4096)
                return 200 <= getattr(response, 'status', 200) < 300
        except (OSError, error.HTTPError, error.URLError) as exc:
            now = time.time()
            # Avoid log spam on employee machines.
            if now - self._last_error_at > 60:
                print(f'employee-tracker cloud upload failed: {exc}', flush=True)
                self._last_error_at = now
            return False
