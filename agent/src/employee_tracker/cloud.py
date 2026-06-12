from __future__ import annotations

from dataclasses import dataclass
from typing import Any
import json
import os
import socket
import time
from urllib import request, error


@dataclass(frozen=True)
class CloudSettings:
    api_url: str
    token: str
    employee_email: str
    company_domain: str
    device_key: str
    upload_interval_seconds: int


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
    upload_interval = int(os.environ.get('EMPLOYEE_TRACKER_CLOUD_UPLOAD_SECONDS', '1'))
    return CloudSettings(
        api_url=api_url,
        token=token.strip(),
        employee_email=employee_email,
        company_domain=company_domain,
        device_key=device_key,
        upload_interval_seconds=max(1, upload_interval),
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
