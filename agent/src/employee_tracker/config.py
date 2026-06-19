from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os


def _parse_path_list(value: str | None) -> tuple[Path, ...]:
    if not value:
        return ()
    if ';' in value:
        separators = ';'
    elif os.name != 'nt' and ':' in value:
        separators = ':'
    else:
        separators = ','
    roots = []
    seen = set()
    for part in value.split(separators):
        stripped = part.strip()
        if not stripped:
            continue
        path = Path(stripped).expanduser()
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        roots.append(path)
    return tuple(roots)


@dataclass(frozen=True)
class Settings:
    db_path: Path
    screenshot_dir: Path
    workspace_dir: Path
    file_roots: tuple[Path, ...]
    poll_interval_seconds: int
    screenshot_interval_seconds: int
    screenshot_activity_idle_seconds: int
    screenshot_similarity_threshold: float
    file_scan_interval_seconds: int
    process_scan_interval_seconds: int
    enable_screenshots: bool
    enable_keyboard_chunks: bool
    keyboard_idle_seconds: float
    keyboard_max_chunk_seconds: float
    enable_file_content: bool
    file_content_max_bytes: int
    enable_process_cwd_roots: bool
    max_dynamic_file_roots: int
    local_success_retention_seconds: int
    local_failed_retention_seconds: int
    app_name: str
    username: str


def load_settings() -> Settings:
    home = Path(os.environ.get('HOME') or os.environ.get('USERPROFILE') or '.').expanduser()
    default_workspace = home / 'Desktop'
    base_dir = Path(os.environ.get('EMPLOYEE_TRACKER_DIR', home / '.local' / 'share' / 'employee-tracker'))
    db_path = Path(os.environ.get('EMPLOYEE_TRACKER_DB', base_dir / 'activity.sqlite3'))
    screenshot_dir = Path(os.environ.get('EMPLOYEE_TRACKER_SCREENSHOT_DIR', base_dir / 'screenshots'))
    workspace_dir = Path(os.environ.get('EMPLOYEE_TRACKER_WORKSPACE', default_workspace)).expanduser()
    file_roots = _parse_path_list(os.environ.get('EMPLOYEE_TRACKER_FILE_ROOTS')) or (workspace_dir,)
    poll_interval_seconds = int(os.environ.get('EMPLOYEE_TRACKER_POLL_SECONDS', '1'))
    file_scan_interval_seconds = int(
        os.environ.get('EMPLOYEE_TRACKER_FILE_SCAN_SECONDS', str(poll_interval_seconds))
    )
    process_scan_interval_seconds = int(
        os.environ.get('EMPLOYEE_TRACKER_PROCESS_SCAN_SECONDS', str(poll_interval_seconds))
    )

    return Settings(
        db_path=db_path,
        screenshot_dir=screenshot_dir,
        workspace_dir=workspace_dir,
        file_roots=file_roots,
        poll_interval_seconds=poll_interval_seconds,
        screenshot_interval_seconds=int(os.environ.get('EMPLOYEE_TRACKER_SCREENSHOT_SECONDS', '60')),
        screenshot_activity_idle_seconds=int(os.environ.get('EMPLOYEE_TRACKER_SCREENSHOT_ACTIVE_IDLE_SECONDS', '300')),
        screenshot_similarity_threshold=float(os.environ.get('EMPLOYEE_TRACKER_SCREENSHOT_SIMILARITY_THRESHOLD', '0.985')),
        file_scan_interval_seconds=file_scan_interval_seconds,
        process_scan_interval_seconds=process_scan_interval_seconds,
        enable_screenshots=os.environ.get('EMPLOYEE_TRACKER_ENABLE_SCREENSHOTS', '1') not in {'0', 'false', 'False'},
        enable_keyboard_chunks=os.environ.get('EMPLOYEE_TRACKER_ENABLE_KEYBOARD_CHUNKS', '0') in {'1', 'true', 'True', 'yes', 'YES'},
        keyboard_idle_seconds=float(os.environ.get('EMPLOYEE_TRACKER_KEYBOARD_IDLE_SECONDS', '2.5')),
        keyboard_max_chunk_seconds=float(os.environ.get('EMPLOYEE_TRACKER_KEYBOARD_MAX_CHUNK_SECONDS', '30')),
        enable_file_content=os.environ.get('EMPLOYEE_TRACKER_ENABLE_FILE_CONTENT', '1') in {'1', 'true', 'True', 'yes', 'YES'},
        file_content_max_bytes=int(os.environ.get('EMPLOYEE_TRACKER_FILE_CONTENT_MAX_BYTES', '65536')),
        enable_process_cwd_roots=os.environ.get('EMPLOYEE_TRACKER_ENABLE_PROCESS_CWD_ROOTS', '1') in {'1', 'true', 'True', 'yes', 'YES'},
        max_dynamic_file_roots=int(os.environ.get('EMPLOYEE_TRACKER_MAX_DYNAMIC_FILE_ROOTS', '8')),
        # Cloud installs should not keep employee activity on the local PC after
        # Supabase accepts it. Keep successful-upload retention at 0 by default;
        # override only for local debugging/export workflows. Failed uploads are
        # kept briefly so transient network outages do not grow without bound.
        local_success_retention_seconds=int(os.environ.get('EMPLOYEE_TRACKER_LOCAL_SUCCESS_RETENTION_SECONDS', '0')),
        local_failed_retention_seconds=int(os.environ.get('EMPLOYEE_TRACKER_LOCAL_FAILED_RETENTION_SECONDS', '3600')),
        app_name=os.environ.get('EMPLOYEE_TRACKER_APP_NAME', 'employee-tracker'),
        username=os.environ.get('EMPLOYEE_TRACKER_USERNAME', os.environ.get('USER', 'unknown')),
    )
