from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from urllib import error, request
import json
import os
import platform
import shutil
import subprocess
import tempfile
import time


@dataclass(frozen=True)
class AutoUpdateSettings:
    enabled: bool
    check_url: str
    token: str
    current_version: str
    interval_seconds: int
    app_dir: Path


def load_auto_update_settings() -> AutoUpdateSettings | None:
    enabled = os.environ.get('EMPLOYEE_TRACKER_AUTO_UPDATE', '1') not in {'0', 'false', 'False', 'no', 'NO'}
    check_url = os.environ.get('EMPLOYEE_TRACKER_UPDATE_CHECK_URL', '').strip()
    token = os.environ.get('EMPLOYEE_TRACKER_ENROLLMENT_TOKEN') or os.environ.get('EMPLOYEE_TRACKER_INGEST_KEY', '')
    current_version = os.environ.get('EMPLOYEE_TRACKER_AGENT_VERSION', 'unknown').strip() or 'unknown'
    try:
        interval_seconds = int(os.environ.get('EMPLOYEE_TRACKER_UPDATE_CHECK_SECONDS', '900'))
    except ValueError:
        interval_seconds = 900
    app_dir = Path(os.environ.get('EMPLOYEE_TRACKER_APP_DIR', Path.home() / '.local/share/neodym-employee-tracker')).expanduser()
    if not check_url or not token:
        return None
    return AutoUpdateSettings(
        enabled=enabled,
        check_url=check_url,
        token=token.strip(),
        current_version=current_version,
        interval_seconds=max(60, interval_seconds),
        app_dir=app_dir,
    )


def _version_changed(current: str, latest: str) -> bool:
    current = (current or '').strip()
    latest = (latest or '').strip()
    if not latest:
        return False
    if current in {'', 'unknown', 'dev'}:
        return latest not in {'unknown', 'dev'}
    return latest != current


class AutoUpdater:
    def __init__(self, settings: AutoUpdateSettings | None = None) -> None:
        self.settings = settings if settings is not None else load_auto_update_settings()
        self._last_check_at = 0.0
        self._last_error_at = 0.0
        self._update_started = False

    def maybe_check(self) -> bool:
        if self.settings is None or not self.settings.enabled or self._update_started:
            return False
        now = time.time()
        if (now - self._last_check_at) < self.settings.interval_seconds:
            return False
        self._last_check_at = now
        return self.check_now()

    def check_now(self) -> bool:
        if self.settings is None or not self.settings.enabled or self._update_started:
            return False
        try:
            info = self._fetch_update_info()
            latest_version = str(info.get('latest_version') or '')
            installer_url = str(info.get('installer_url') or '')
            if not _version_changed(self.settings.current_version, latest_version) or not installer_url:
                return False
            self._update_started = True
            print(
                f'employee-tracker auto-update available: {self.settings.current_version} -> {latest_version}',
                flush=True,
            )
            self._launch_installer(installer_url, latest_version)
            return True
        except Exception as exc:  # keep the collector alive no matter what happens here
            now = time.time()
            if now - self._last_error_at > 60:
                print(f'employee-tracker auto-update check failed: {exc}', flush=True)
                self._last_error_at = now
            return False

    def _fetch_update_info(self) -> dict[str, object]:
        assert self.settings is not None
        req = request.Request(
            self.settings.check_url,
            method='GET',
            headers={
                'accept': 'application/json',
                'x-enrollment-token': self.settings.token,
                'x-current-agent-version': self.settings.current_version,
            },
        )
        try:
            with request.urlopen(req, timeout=10) as response:
                data = response.read(512 * 1024)
        except (OSError, error.HTTPError, error.URLError):
            raise
        parsed = json.loads(data.decode('utf-8'))
        if not isinstance(parsed, dict):
            raise ValueError('update endpoint did not return an object')
        return parsed

    def _script_suffix(self) -> str:
        system = platform.system().lower()
        if system == 'windows':
            return '.cmd'
        return '.sh'

    def _download_installer(self, installer_url: str, latest_version: str) -> Path:
        assert self.settings is not None
        update_dir = self.settings.app_dir / 'updates'
        update_dir.mkdir(parents=True, exist_ok=True)
        suffix = self._script_suffix()
        safe_version = ''.join(ch if ch.isalnum() or ch in ('-', '_', '.') else '_' for ch in latest_version)[:80] or 'latest'
        fd, name = tempfile.mkstemp(prefix=f'neodym-update-{safe_version}-', suffix=suffix, dir=str(update_dir))
        os.close(fd)
        path = Path(name)
        req = request.Request(installer_url, method='GET', headers={'x-enrollment-token': self.settings.token})
        with request.urlopen(req, timeout=60) as response:
            path.write_bytes(response.read())
        if suffix == '.sh':
            path.chmod(0o700)
        return path

    def _launch_installer(self, installer_url: str, latest_version: str) -> None:
        path = self._download_installer(installer_url, latest_version)
        env = os.environ.copy()
        env['EMPLOYEE_TRACKER_AUTO_UPDATE_CHILD'] = '1'
        env['EMPLOYEE_TRACKER_AUTO_UPDATE_TARGET_VERSION'] = latest_version
        system = platform.system().lower()
        if system == 'windows':
            subprocess.Popen(['cmd.exe', '/c', str(path)], env=env, close_fds=True)
        else:
            systemd_run = shutil.which('systemd-run')
            if system == 'linux' and systemd_run:
                unit = f"neodym-tracker-auto-update-{int(time.time())}"
                try:
                    subprocess.Popen([
                        systemd_run,
                        '--user',
                        '--unit',
                        unit,
                        '--collect',
                        'bash',
                        str(path),
                    ], env=env, start_new_session=True, close_fds=True)
                except OSError:
                    subprocess.Popen(['bash', str(path)], env=env, start_new_session=True, close_fds=True)
            else:
                subprocess.Popen(['bash', str(path)], env=env, start_new_session=True, close_fds=True)
        # Keep the current collector alive while the updater runs. If the installer succeeds it
        # will restart the service itself; if it fails or blocks in a non-interactive context,
        # telemetry should continue instead of silently going dark.
        print('employee-tracker auto-update installer launched in background', flush=True)
