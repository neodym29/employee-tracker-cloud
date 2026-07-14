from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Sequence
import base64
import time

SENSITIVE_TEXT_MARKERS = ('password', 'passcode', 'otp', '2fa', 'token', 'secret', 'private key', 'card', 'login', 'sign in', 'signin')


def _session_key(row: dict[str, object]) -> tuple[str, str, str]:
    return (
        str(row.get('window_id') or ''),
        str(row.get('app_name') or 'unknown'),
        str(row.get('window_title') or 'unknown'),
    )


def _is_sensitive_session(rows: list[dict[str, object]]) -> bool:
    for row in rows:
        if row.get('sensitive'):
            return True
        haystack = ' '.join(
            str(row.get(key) or '')
            for key in ('window_title', 'field_hint', 'url', 'typed_text')
        ).lower()
        if any(marker in haystack for marker in SENSITIVE_TEXT_MARKERS):
            return True
    return False


def _plural(count: int, singular: str) -> str:
    return f'{count} {singular}' if count == 1 else f'{count} {singular}s'


def _decode_browser_screenshot(data_url: str) -> tuple[bytes, str, str] | None:
    if not data_url.startswith('data:image/') or ';base64,' not in data_url:
        return None
    header, encoded = data_url.split(';base64,', 1)
    mime_type = header.removeprefix('data:').lower()
    extension = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/webp': '.webp',
    }.get(mime_type)
    if extension is None:
        return None
    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except Exception:
        return None
    if not image_bytes:
        return None
    return image_bytes, mime_type, extension


def _int_value(value: object, default: int = 0) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def build_activity_session_events(
    *,
    captured_at: str,
    typing_rows: list[dict[str, object]],
    click_rows: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Build v6-style activity_session blocks from the current upload tick.

    This intentionally preserves the existing privacy posture: the browser bridge only
    sends safe/redacted typing summaries, and sensitive fields stay redacted.
    """
    grouped: dict[tuple[str, str, str], dict[str, object]] = {}
    source_rows: dict[tuple[str, str, str], list[dict[str, object]]] = {}

    for row in typing_rows:
        key = _session_key(row)
        session = grouped.setdefault(
            key,
            {
                'captured_at': captured_at,
                'event_type': 'activity_session',
                'app_name': key[1],
                'window_title': key[2],
                'window_id': key[0] or None,
                'url': row.get('url'),
                'source': row.get('source') or 'employee-tracker-sessionizer',
                'started_by': 'typing',
                'key_count': 0,
                'click_count': 0,
                'text_length': 0,
                'word_count': 0,
                'field_hints': [],
                'typed_text': '',
                'clicks': [],
            },
        )
        source_rows.setdefault(key, []).append(row)
        session['key_count'] = _int_value(session.get('key_count')) + _int_value(row.get('key_count'))
        session['text_length'] = _int_value(session.get('text_length')) + _int_value(row.get('text_length'))
        session['word_count'] = _int_value(session.get('word_count')) + _int_value(row.get('word_count'))
        field_hint = row.get('field_hint')
        if field_hint and field_hint not in session['field_hints']:
            session['field_hints'].append(field_hint)
        typed_text = row.get('typed_text')
        if typed_text and not session.get('typed_text'):
            session['typed_text'] = typed_text
        if row.get('url') and not session.get('url'):
            session['url'] = row.get('url')

    for row in click_rows:
        key = _session_key(row)
        session = grouped.setdefault(
            key,
            {
                'captured_at': captured_at,
                'event_type': 'activity_session',
                'app_name': key[1],
                'window_title': key[2],
                'window_id': key[0] or None,
                'url': row.get('url'),
                'source': row.get('source') or 'employee-tracker-sessionizer',
                'started_by': 'click',
                'key_count': 0,
                'click_count': 0,
                'text_length': 0,
                'word_count': 0,
                'field_hints': [],
                'typed_text': '',
                'clicks': [],
            },
        )
        source_rows.setdefault(key, []).append(row)
        click = {
            'captured_at': row.get('captured_at'),
            'button': row.get('button'),
            'x': row.get('x'),
            'y': row.get('y'),
            'screen_x': row.get('screen_x'),
            'screen_y': row.get('screen_y'),
            'target_hint': row.get('target_hint'),
            'url': row.get('url'),
        }
        session['clicks'].append(click)
        session['click_count'] = _int_value(session.get('click_count')) + 1
        if row.get('url') and not session.get('url'):
            session['url'] = row.get('url')

    sessions = []
    for key, session in grouped.items():
        sensitive = _is_sensitive_session(source_rows.get(key, []))
        session['sensitive'] = sensitive
        if sensitive and session.get('typed_text'):
            session['typed_text'] = '[REDACTED_SENSITIVE_INPUT]'
        parts = []
        if session.get('key_count'):
            parts.append(f"typed {session['text_length']} chars")
            parts.append(_plural(int(session['key_count']), 'input event'))
        if session.get('click_count'):
            parts.append(_plural(int(session['click_count']), 'click'))
        if session.get('field_hints'):
            parts.append('fields=' + ', '.join(str(value) for value in session['field_hints'][:3]))
        session['summary'] = ' · '.join(parts) or 'activity session'
        sessions.append(session)
    return sessions

from .auto_update import AutoUpdater
from .browser_bridge import BrowserBridge
from .cloud import CloudUploader, load_cloud_settings
from .clipboard import ClipboardWatcher
from .db import (
    connect,
    fetch_file_state_rows,
    insert_activity,
    insert_current_app_snapshot,
    insert_current_subwindow_snapshot,
    insert_file_event,
    insert_clipboard_event,
    insert_input_click_event,
    insert_keystroke_event,
    insert_typing_activity_event,
    insert_window_focus_event,
    insert_audio_output_snapshot,
    insert_browser_compliance_event,
    insert_peripheral_snapshot,
    insert_process_lifecycle_event,
    insert_process_snapshot,
    insert_resource_usage_snapshot,
    insert_screenshot_event,
    insert_warp_activity_snapshot,
    insert_window_snapshot,
    mark_file_deleted,
    prune_local_telemetry,
    enqueue_cloud_payload,
    upsert_file_state,
)
from .resources import collect_resource_usage
from .keyboard_chunks import KeyboardChunkRecorder, serialize_keys
from .screenshots import capture_screenshot_with_status, screenshot_similarity
from .terminal_commands import TerminalCommandReader
from .system import (
    XInputClickReader,
    current_window_info,
    diff_process_maps,
    host_name,
    idle_seconds,
    list_audio_outputs,
    list_open_windows,
    list_peripherals,
    list_processes,
    process_map_by_pid,
    summarize_current_open_state,
    summarize_warp_activity,
)
from .workspace import capture_file_content, scan_workspace


class ActivityCollector:
    def __init__(
        self,
        db_path: Path,
        screenshot_dir: Path,
        workspace_dir: Path,
        username: str,
        file_roots: tuple[Path, ...] | None = None,
        poll_interval_seconds: int = 1,
        screenshot_interval_seconds: int = 60,
        file_scan_interval_seconds: int = 120,
        process_scan_interval_seconds: int = 60,
        state_snapshot_interval_seconds: int = 10,
        enable_screenshots: bool = True,
        enable_keyboard_chunks: bool = False,
        keyboard_idle_seconds: float = 2.5,
        keyboard_max_chunk_seconds: float = 30.0,
        screenshot_activity_idle_seconds: int = 300,
        screenshot_similarity_threshold: float = 0.985,
        enable_file_content: bool = False,
        file_content_max_bytes: int = 65536,
        enable_process_cwd_roots: bool = True,
        enable_clipboard: bool = True,
        clipboard_max_text_chars: int = 4096,
        clipboard_poll_interval_seconds: float = 120.0,
        clipboard_startup_delay_seconds: float = 30.0,
        enable_audio_outputs: bool = False,
        max_dynamic_file_roots: int = 8,
        max_file_roots_per_scan: int = 1,
        local_success_retention_seconds: int = 86400,
        local_failed_retention_seconds: int = 3600,
        local_cleanup_interval_seconds: int = 300,
    ) -> None:
        self.db_path = db_path
        self.screenshot_dir = screenshot_dir
        self.workspace_dir = workspace_dir.resolve()
        self.file_roots = tuple(dict.fromkeys((root.expanduser().resolve() for root in (file_roots or (self.workspace_dir,)))))
        self.username = username
        self.poll_interval_seconds = poll_interval_seconds
        self.screenshot_interval_seconds = screenshot_interval_seconds
        self.screenshot_activity_idle_seconds = screenshot_activity_idle_seconds
        self.screenshot_similarity_threshold = screenshot_similarity_threshold
        self.enable_file_content = enable_file_content
        self.file_content_max_bytes = file_content_max_bytes
        self.enable_process_cwd_roots = enable_process_cwd_roots
        self.enable_clipboard = enable_clipboard
        self.clipboard_max_text_chars = clipboard_max_text_chars
        self.clipboard_poll_interval_seconds = clipboard_poll_interval_seconds
        self.clipboard_startup_delay_seconds = clipboard_startup_delay_seconds
        self.enable_audio_outputs = enable_audio_outputs
        self.max_dynamic_file_roots = max_dynamic_file_roots
        self.max_file_roots_per_scan = max(1, max_file_roots_per_scan)
        self._file_root_batch_cursor = 0
        self.local_success_retention_seconds = max(0, local_success_retention_seconds)
        self.local_failed_retention_seconds = max(0, local_failed_retention_seconds)
        self.local_cleanup_interval_seconds = max(60, local_cleanup_interval_seconds)
        self._last_local_cleanup_at = 0.0
        self.file_scan_interval_seconds = file_scan_interval_seconds
        self.process_scan_interval_seconds = process_scan_interval_seconds
        self.state_snapshot_interval_seconds = max(1, state_snapshot_interval_seconds)
        self.enable_screenshots = enable_screenshots
        self.enable_keyboard_chunks = enable_keyboard_chunks
        self._keyboard_recorder = KeyboardChunkRecorder(
            self.db_path.parent / 'keyboard-chunks',
            idle_seconds=keyboard_idle_seconds,
            max_chunk_seconds=keyboard_max_chunk_seconds,
        ) if enable_keyboard_chunks else None
        if self._keyboard_recorder is not None:
            self._keyboard_recorder.start()
        self._last_screenshot_at: float = 0.0
        self._last_uploaded_screenshot_path: Path | None = None
        # Do not block first cloud connection on a potentially large home-directory scan.
        self._last_file_scan_at: float = time.time()
        self._last_process_scan_at: float = 0.0
        self._last_state_snapshot_at: float = 0.0
        self._cached_windows: list[object] = []
        self._cached_open_state: dict[str, list[dict[str, object]]] = {'open_apps': [], 'subwindows': [], 'browser_compliance_events': []}
        self._last_keyboard_status_at: float = 0.0
        self._workspace_root = str(self.workspace_dir)
        self._file_roots = tuple(str(root) for root in self.file_roots)
        self._file_state = self._load_file_state()
        self._process_state: dict[int, object] = {}
        self._last_window = None
        self._click_reader = XInputClickReader()
        self._terminal_command_reader = TerminalCommandReader()
        self._clipboard_watcher = ClipboardWatcher(
            max_text_chars=clipboard_max_text_chars,
            min_poll_interval_seconds=clipboard_poll_interval_seconds,
            startup_delay_seconds=clipboard_startup_delay_seconds,
        ) if enable_clipboard else None
        self._last_clipboard_status_key: tuple[str, str | None, str | None] | None = None
        self._browser_bridge = BrowserBridge()
        self._browser_bridge.start()
        self._cloud_uploader = CloudUploader(load_cloud_settings())
        self._auto_updater = AutoUpdater()

    def _load_file_state(self) -> dict[tuple[str, str], dict[str, object]]:
        state: dict[tuple[str, str], dict[str, object]] = {}
        tracked_roots = set(self._file_roots)
        for row in fetch_file_state_rows(self.db_path):
            workspace_root = row['workspace_root']
            if workspace_root not in tracked_roots:
                continue
            state[(workspace_root, row['relative_path'])] = dict(row)
        return state

    def _workspace_event_payload(self, snapshot, *, event_type: str, captured_at: str, host: str, workspace_root: str, previous: dict[str, object] | None = None, note: str | None = None) -> dict[str, object]:
        row: dict[str, object] = {
            'captured_at': captured_at,
            'username': self.username,
            'host': host,
            'workspace_root': workspace_root,
            'absolute_path': snapshot.absolute_path,
            'relative_path': snapshot.relative_path,
            'event_type': event_type,
            'previous_size': previous.get('file_size') if previous else None,
            'previous_line_count': previous.get('line_count') if previous else None,
            'previous_sha256': previous.get('sha256') if previous else None,
            'file_size': snapshot.file_size,
            'line_count': snapshot.line_count,
            'sha256': snapshot.sha256,
            'language': snapshot.language,
            'note': note,
        }
        if self.enable_file_content and event_type in {'created', 'modified'}:
            capture = capture_file_content(Path(snapshot.absolute_path), max_bytes=self.file_content_max_bytes)
            row.update({
                'content_status': capture.status,
                'content_encoding': capture.encoding,
                'content_text': capture.content,
                'content_truncated': capture.truncated,
                'content_redacted': capture.redacted,
                'content_bytes_read': capture.bytes_read,
                'content_reason': capture.reason,
            })
        return row

    def _file_change_rich_event(self, row: dict[str, object]) -> dict[str, object]:
        event = {
            'captured_at': row.get('captured_at'),
            'event_type': 'file_change',
            'app_name': 'filesystem',
            'window_title': row.get('relative_path'),
            'workspace_root': row.get('workspace_root'),
            'absolute_path': row.get('absolute_path'),
            'relative_path': row.get('relative_path'),
            'file_event_type': row.get('event_type'),
            'previous_size': row.get('previous_size'),
            'previous_line_count': row.get('previous_line_count'),
            'previous_sha256': row.get('previous_sha256'),
            'file_size': row.get('file_size'),
            'line_count': row.get('line_count'),
            'sha256': row.get('sha256'),
            'language': row.get('language'),
            'note': row.get('note'),
            'content_status': row.get('content_status'),
            'content_encoding': row.get('content_encoding'),
            'content': row.get('content_text'),
            'content_truncated': row.get('content_truncated'),
            'content_redacted': row.get('content_redacted'),
            'content_bytes_read': row.get('content_bytes_read'),
            'content_reason': row.get('content_reason'),
            'source': 'workspace_file_scanner',
        }
        return {key: value for key, value in event.items() if value is not None}

    def _is_candidate_working_root(self, path: Path) -> bool:
        try:
            resolved = path.expanduser().resolve()
            home = Path.home().resolve()
            resolved.relative_to(home)
        except Exception:
            return False
        # Never promote $HOME itself to a dynamic project root. A shell whose CWD is
        # the home directory must not turn a project scan into a recursive account scan.
        if resolved == home:
            return False
        excluded_parts = {'.git', 'node_modules', '.cache', '.config', '.local', '.var', '__pycache__', 'dist', 'build'}
        return not any(part in excluded_parts for part in resolved.parts)

    def _dynamic_file_roots(self, current_processes: list[object]) -> tuple[Path, ...]:
        if not self.enable_process_cwd_roots:
            return ()
        interesting_names = {'code', 'cursor', 'codium', 'python', 'python3', 'node', 'npm', 'pnpm', 'yarn', 'git', 'bash', 'zsh', 'fish', 'sh', 'warp-terminal'}
        roots: list[Path] = []
        seen = {str(root.resolve()) for root in self.file_roots if root.exists()}
        for process in current_processes:
            cwd = getattr(process, 'cwd', None)
            name = (getattr(process, 'process_name', None) or '').lower()
            if not cwd or (name and name not in interesting_names and not any(token in name for token in ('code', 'cursor', 'terminal'))):
                continue
            candidate = Path(str(cwd))
            if not candidate.exists() or not candidate.is_dir() or not self._is_candidate_working_root(candidate):
                continue
            key = str(candidate.resolve())
            if key in seen:
                continue
            seen.add(key)
            roots.append(candidate)
            if len(roots) >= self.max_dynamic_file_roots:
                break
        return tuple(roots)

    def _next_file_root_batch(self, current_processes: list[object]) -> tuple[Path, ...]:
        roots = tuple(dict.fromkeys((*self.file_roots, *self._dynamic_file_roots(current_processes))))
        if not roots:
            return ()
        start = self._file_root_batch_cursor % len(roots)
        count = min(self.max_file_roots_per_scan, len(roots))
        batch = tuple(roots[(start + offset) % len(roots)].resolve() for offset in range(count))
        self._file_root_batch_cursor = (start + count) % len(roots)
        return batch

    def _record_workspace_snapshot(self, connection, captured_at: str, host: str, current_processes: list[object] | None = None, roots: tuple[Path, ...] | None = None) -> list[dict[str, object]]:
        roots = roots if roots is not None else tuple(dict.fromkeys((*self.file_roots, *self._dynamic_file_roots(current_processes or []))))
        events: list[dict[str, object]] = []
        for file_root in roots:
            events.extend(self._record_file_root_snapshot(connection, captured_at, host, file_root))
        return events

    def _record_file_root_snapshot(self, connection, captured_at: str, host: str, file_root: Path) -> list[dict[str, object]]:
        root = file_root.resolve()
        workspace_root = str(root)
        previous_by_relative_path = {
            key[1]: value for key, value in self._file_state.items() if key[0] == workspace_root
        }
        snapshots = scan_workspace(root, previous_state=previous_by_relative_path)
        current_paths: set[str] = set()
        baseline_mode = not any(key[0] == workspace_root for key in self._file_state)
        events: list[dict[str, object]] = []

        for snapshot in snapshots:
            state_key = (workspace_root, snapshot.relative_path)
            current_paths.add(snapshot.relative_path)
            previous = self._file_state.get(state_key)
            if previous is None:
                event_type = 'baseline' if baseline_mode else 'created'
                note = 'initial file inventory' if baseline_mode else 'file added to tracked root'
                row = self._workspace_event_payload(
                    snapshot,
                    event_type=event_type,
                    captured_at=captured_at,
                    host=host,
                    workspace_root=workspace_root,
                    previous=None,
                    note=note,
                )
                insert_file_event(connection, row)
                if event_type != 'baseline':
                    events.append(row)
            else:
                previous_size = previous.get('file_size')
                previous_line_count = previous.get('line_count')
                previous_sha256 = previous.get('sha256')
                current_size = snapshot.file_size
                current_line_count = snapshot.line_count
                current_sha256 = snapshot.sha256
                if (
                    previous_size != current_size
                    or previous_line_count != current_line_count
                    or previous_sha256 != current_sha256
                ):
                    size_delta = None
                    if isinstance(previous_size, int):
                        size_delta = current_size - previous_size
                    line_delta = None
                    if isinstance(previous_line_count, int) and isinstance(current_line_count, int):
                        line_delta = current_line_count - previous_line_count
                    note_parts = ['file modified']
                    if size_delta is not None:
                        note_parts.append(f'size delta {size_delta:+d} bytes')
                    if line_delta is not None:
                        note_parts.append(f'line delta {line_delta:+d}')
                    row = self._workspace_event_payload(
                        snapshot,
                        event_type='modified',
                        captured_at=captured_at,
                        host=host,
                        workspace_root=workspace_root,
                        previous=previous,
                        note='; '.join(note_parts),
                    )
                    insert_file_event(connection, row)
                    events.append(row)

            upsert_file_state(
                connection,
                {
                    'workspace_root': workspace_root,
                    'absolute_path': snapshot.absolute_path,
                    'relative_path': snapshot.relative_path,
                    'file_size': snapshot.file_size,
                    'mtime_ns': snapshot.mtime_ns,
                    'line_count': snapshot.line_count,
                    'sha256': snapshot.sha256,
                    'language': snapshot.language,
                    'last_seen_at': captured_at,
                },
            )
            self._file_state[state_key] = {
                'workspace_root': workspace_root,
                'absolute_path': snapshot.absolute_path,
                'relative_path': snapshot.relative_path,
                'file_size': snapshot.file_size,
                'mtime_ns': snapshot.mtime_ns,
                'line_count': snapshot.line_count,
                'sha256': snapshot.sha256,
                'language': snapshot.language,
                'last_seen_at': captured_at,
                'deleted_at': None,
            }

        deleted_keys = [
            key for key in list(self._file_state)
            if key[0] == workspace_root and key[1] not in current_paths
        ]
        for state_key in deleted_keys:
            _, relative_path = state_key
            previous = self._file_state[state_key]
            row = {
                'captured_at': captured_at,
                'username': self.username,
                'host': host,
                'workspace_root': workspace_root,
                'absolute_path': previous['absolute_path'],
                'relative_path': relative_path,
                'event_type': 'deleted',
                'previous_size': previous.get('file_size'),
                'previous_line_count': previous.get('line_count'),
                'previous_sha256': previous.get('sha256'),
                'file_size': None,
                'line_count': None,
                'sha256': None,
                'language': previous.get('language'),
                'note': 'file removed from tracked root',
            }
            insert_file_event(connection, row)
            events.append(row)
            mark_file_deleted(connection, workspace_root, relative_path, captured_at)
            del self._file_state[state_key]

        return [self._file_change_rich_event(row) for row in events]

    def _record_process_snapshot(self, connection, captured_at: str, host: str) -> list[object]:
        current_processes = process_map_by_pid(list_processes())
        baseline_mode = not self._process_state
        started, exited = diff_process_maps(self._process_state, current_processes)

        for process in current_processes.values():
            insert_process_snapshot(
                connection,
                {
                    'captured_at': captured_at,
                    'username': self.username,
                    'host': host,
                    'pid': process.pid,
                    'ppid': process.ppid,
                    'process_name': process.process_name,
                    'exe_path': process.exe_path,
                    'cwd': process.cwd,
                    'command_line': process.command_line,
                    'state': process.state,
                    'uid': process.uid,
                    'process_username': process.username,
                    'start_time_ticks': process.start_time_ticks,
                },
            )

        lifecycle_type = 'baseline' if baseline_mode else 'started'
        lifecycle_note = 'initial process inventory' if baseline_mode else 'process observed as started'
        for process in current_processes.values() if baseline_mode else started:
            insert_process_lifecycle_event(
                connection,
                {
                    'captured_at': captured_at,
                    'username': self.username,
                    'host': host,
                    'event_type': lifecycle_type,
                    'pid': process.pid,
                    'ppid': process.ppid,
                    'process_name': process.process_name,
                    'exe_path': process.exe_path,
                    'cwd': process.cwd,
                    'command_line': process.command_line,
                    'state': process.state,
                    'uid': process.uid,
                    'process_username': process.username,
                    'start_time_ticks': process.start_time_ticks,
                    'note': lifecycle_note,
                },
            )

        for process in exited:
            insert_process_lifecycle_event(
                connection,
                {
                    'captured_at': captured_at,
                    'username': self.username,
                    'host': host,
                    'event_type': 'exited',
                    'pid': process.pid,
                    'ppid': process.ppid,
                    'process_name': process.process_name,
                    'exe_path': process.exe_path,
                    'cwd': process.cwd,
                    'command_line': process.command_line,
                    'state': process.state,
                    'uid': process.uid,
                    'process_username': process.username,
                    'start_time_ticks': process.start_time_ticks,
                    'note': 'process no longer present in /proc snapshot',
                },
            )

        self._process_state = current_processes
        return list(current_processes.values())

    def _record_window_snapshot(self, connection, captured_at: str, host: str) -> list[object]:
        windows = list_open_windows()
        gnome_windows = self._browser_bridge.current_gnome_windows()
        if gnome_windows:
            x_window_ids = {getattr(window, 'window_id', None) for window in windows}
            windows.extend([window for window in gnome_windows if window.window_id not in x_window_ids])
        for window in windows:
            insert_window_snapshot(
                connection,
                {
                    'captured_at': captured_at,
                    'username': self.username,
                    'host': host,
                    'window_id': window.window_id,
                    'window_title': window.title,
                    'app_name': window.app_name,
                    'window_pid': window.pid,
                    'window_class': window.wm_class,
                    'is_active': window.is_active,
                },
            )
        return windows

    def _record_warp_activity(self, connection, captured_at: str, host: str, processes: list[object], windows: list[object]) -> None:
        for warp in summarize_warp_activity(processes, windows):
            insert_warp_activity_snapshot(
                connection,
                {
                    'captured_at': captured_at,
                    'username': self.username,
                    'host': host,
                    'warp_pid': warp.warp_pid,
                    'shell_pid': warp.shell_pid,
                    'observed_pid': warp.observed_pid,
                    'observed_process_name': warp.observed_process_name,
                    'observed_command_line': warp.observed_command_line,
                    'note': warp.note,
                },
            )

    def _record_current_open_state(self, connection, captured_at: str, host: str, processes: list[object], windows: list[object]) -> dict[str, list[dict[str, object]]]:
        apps, subwindows = summarize_current_open_state(processes, windows)
        browser_tabs = self._browser_bridge.current_tabs()
        app_rows = {
            app.app_key: {
                'captured_at': captured_at,
                'username': self.username,
                'host': host,
                'app_key': app.app_key,
                'app_name': app.app_name,
                'pid': app.pid,
                'process_name': app.process_name,
                'window_count': app.window_count,
                'subwindow_count': app.subwindow_count,
                'source': app.source,
            }
            for app in apps
        }
        subwindow_rows = [
            {
                'captured_at': captured_at,
                'username': self.username,
                'host': host,
                'app_key': subwindow.app_key,
                'app_name': subwindow.app_name,
                'subwindow_type': subwindow.subwindow_type,
                'title': subwindow.title,
                'url': subwindow.url,
                'window_id': subwindow.window_id,
                'pid': subwindow.pid,
                'is_active': subwindow.is_active,
                'source': subwindow.source,
            }
            for subwindow in subwindows
        ]

        extension_app_keys = {tab.app_key for tab in browser_tabs}
        if extension_app_keys:
            subwindow_rows = [
                row for row in subwindow_rows
                if not (row['app_key'] in extension_app_keys and str(row.get('source') or '').endswith('-session'))
            ]
        for tab in browser_tabs:
            app_row = app_rows.setdefault(
                tab.app_key,
                {
                    'captured_at': captured_at,
                    'username': self.username,
                    'host': host,
                    'app_key': tab.app_key,
                    'app_name': tab.browser,
                    'pid': None,
                    'process_name': None,
                    'window_count': 0,
                    'subwindow_count': 0,
                    'source': 'browser-extension',
                },
            )
            if 'browser-extension' not in str(app_row.get('source') or ''):
                app_row['source'] = f"{app_row.get('source') or 'process'}+browser-extension"
            indicators = []
            if tab.audible and not tab.muted:
                indicators.append('🔊 audible')
            if tab.muted:
                indicators.append('🔇 muted')
            if tab.active and tab.window_focused:
                indicators.append('active')
            title = tab.title or tab.url or 'Untitled browser tab'
            if indicators:
                title = f"{' · '.join(indicators)} — {title}"
            subwindow_rows.append(
                {
                    'captured_at': captured_at,
                    'username': self.username,
                    'host': host,
                    'app_key': tab.app_key,
                    'app_name': tab.browser,
                    'subwindow_type': 'tab',
                    'title': title,
                    'url': tab.url,
                    'window_id': f'browser:{tab.app_key}:window:{tab.window_id}:tab:{tab.tab_id}',
                    'pid': app_row.get('pid'),
                    'is_active': tab.active and tab.window_focused,
                    'source': 'browser-extension',
                }
            )

        counts: dict[str, int] = {}
        windows_counts: dict[str, set[str]] = {}
        for row in subwindow_rows:
            counts[row['app_key']] = counts.get(row['app_key'], 0) + 1
            if row.get('window_id'):
                windows_counts.setdefault(row['app_key'], set()).add(str(row['window_id']).split(':tab:', 1)[0])
        for key, app_row in app_rows.items():
            app_row['subwindow_count'] = counts.get(key, app_row.get('subwindow_count', 0))
            if key in windows_counts:
                app_row['window_count'] = max(int(app_row.get('window_count') or 0), len(windows_counts[key]))

        browser_compliance_events = self._record_browser_compliance_events(connection, captured_at, host, app_rows, browser_tabs)

        for app in app_rows.values():
            insert_current_app_snapshot(
                connection,
                app,
            )
        for subwindow in subwindow_rows:
            insert_current_subwindow_snapshot(
                connection,
                subwindow,
            )
        return {'open_apps': list(app_rows.values()), 'subwindows': subwindow_rows, 'browser_compliance_events': browser_compliance_events}


    def _record_browser_focus_events(self, connection, captured_at: str, host: str) -> list[dict[str, object]]:
        rows: list[dict[str, object]] = []
        for event in self._browser_bridge.read_focus_events():
            row = {
                    'captured_at': captured_at,
                    'username': self.username,
                    'host': host,
                    'from_window_id': event.from_window_id,
                    'from_window_title': event.from_title,
                    'from_app_name': event.from_app_name,
                    'to_window_id': event.to_window_id,
                    'to_window_title': event.to_title,
                    'to_app_name': event.to_app_name,
                    'to_window_pid': None,
                    'to_window_class': event.to_window_class,
                    'reason': event.reason,
                }
            rows.append(row)
            insert_window_focus_event(
                connection,
                row,
            )
        return rows

    def _record_window_focus_event(self, connection, captured_at: str, host: str, window) -> None:
        previous = self._last_window
        changed = previous is None or (
            previous.window_id != window.window_id
            or previous.title != window.title
            or previous.app_name != window.app_name
        )
        if not changed:
            return
        reason = 'initial-active-window' if previous is None else 'active-window-or-title-changed'
        insert_window_focus_event(
            connection,
            {
                'captured_at': captured_at,
                'username': self.username,
                'host': host,
                'from_window_id': previous.window_id if previous else None,
                'from_window_title': previous.title if previous else None,
                'from_app_name': previous.app_name if previous else None,
                'to_window_id': window.window_id,
                'to_window_title': window.title,
                'to_app_name': window.app_name,
                'to_window_pid': window.pid,
                'to_window_class': window.wm_class,
                'reason': reason,
            },
        )
        self._last_window = window

    def _record_click_events(self, connection, captured_at: str, host: str, window, windows: list[object]) -> list[dict[str, object]]:
        rows: list[dict[str, object]] = []
        for click in self._browser_bridge.read_clicks():
            target = click.target_text or click.href or click.title or click.url or 'browser content'
            page = click.title or click.url or click.browser
            muted = ' muted' if click.muted else ''
            audible = ' audible' if click.audible and not click.muted else muted
            row = {
                'captured_at': captured_at,
                'username': self.username,
                'host': host,
                'button': click.button,
                'x': click.x,
                'y': click.y,
                'screen_x': click.screen_x,
                'screen_y': click.screen_y,
                'window_id': f'browser:{click.app_key}:window:{click.window_id}:tab:{click.tab_id}',
                'window_title': page,
                'app_name': click.browser,
                'window_pid': None,
                'window_class': click.app_key,
                'target_hint': f'click on {target} in {page} ({click.url or "no url"}){audible}',
                'url': click.url,
                'source': click.source,
            }
            rows.append(row)
            insert_input_click_event(
                connection,
                row,
            )
        for click in self._click_reader.read_clicks():
            clicked_window = self._window_at_click(click, windows) or window
            target_hint = self._click_target_hint(click, clicked_window)
            row = {
                'captured_at': captured_at,
                'username': self.username,
                'host': host,
                'button': click.button,
                'x': click.x,
                'y': click.y,
                'screen_x': click.screen_x,
                'screen_y': click.screen_y,
                'window_id': clicked_window.window_id,
                'window_title': clicked_window.title,
                'app_name': clicked_window.app_name,
                'window_pid': clicked_window.pid,
                'window_class': clicked_window.wm_class,
                'target_hint': target_hint,
                'source': click.source,
            }
            rows.append(row)
            insert_input_click_event(
                connection,
                row,
            )
        return rows

    def _window_at_click(self, click, windows: list[object]):
        screen_x = click.screen_x if click.screen_x is not None else click.x
        screen_y = click.screen_y if click.screen_y is not None else click.y
        if screen_x is None or screen_y is None:
            return None
        matches = []
        for stack_index, candidate in enumerate(windows):
            x = getattr(candidate, 'x', None)
            y = getattr(candidate, 'y', None)
            width = getattr(candidate, 'width', None)
            height = getattr(candidate, 'height', None)
            if x is None or y is None or width is None or height is None:
                continue
            if x <= screen_x < x + width and y <= screen_y < y + height:
                area = width * height
                # _NET_CLIENT_LIST_STACKING is bottom-to-top on EWMH desktops; prefer topmost.
                matches.append((area, -stack_index, candidate))
        if not matches:
            return None
        matches.sort(key=lambda item: (item[0], item[1]))
        return matches[0][2]

    def _click_target_hint(self, click, window) -> str:
        button_name = {1: 'left', 2: 'middle', 3: 'right'}.get(click.button, f'button {click.button}' if click.button else 'button')
        coords = []
        if click.screen_x is not None and click.screen_y is not None:
            coords.append(f'screen=({click.screen_x:.0f},{click.screen_y:.0f})')
        if click.x is not None and click.y is not None:
            coords.append(f'window=({click.x:.0f},{click.y:.0f})')
        target = window.title or window.app_name or window.window_id or 'unknown window'
        return f'{button_name} click on {target}; ' + ', '.join(coords)

    def _record_clipboard_event(self, connection, captured_at: str, host: str, window) -> list[dict[str, object]]:
        watcher = self._clipboard_watcher
        if watcher is None:
            return []
        capture = watcher.poll()
        if capture.status in {'unchanged', 'deferred'}:
            return []
        is_status_only = capture.status not in {'captured', 'empty'}
        event_type = 'clipboard_status' if is_status_only else 'clipboard_change'
        status_key = (capture.status, capture.source, capture.reason)
        if is_status_only and status_key == self._last_clipboard_status_key:
            return []
        if not is_status_only:
            self._last_clipboard_status_key = None
        else:
            self._last_clipboard_status_key = status_key
        row = {
            'captured_at': captured_at,
            'username': self.username,
            'host': host,
            'event_type': event_type,
            'app_name': getattr(window, 'app_name', None) or 'Clipboard',
            'window_title': getattr(window, 'title', None) or 'clipboard change',
            'window_id': getattr(window, 'window_id', None),
            'content': capture.content,
            'content_hash': capture.content_hash,
            'content_length': capture.content_length,
            'content_redacted': capture.content_redacted,
            'content_truncated': capture.content_truncated,
            'source': capture.source or 'clipboard',
            'status': capture.status,
            'reason': capture.reason,
        }
        insert_clipboard_event(connection, row)
        return [row]


    def _record_terminal_command_events(self) -> list[dict[str, object]]:
        rows: list[dict[str, object]] = []
        for command in self._terminal_command_reader.read_commands():
            rows.append(
                {
                    'captured_at': command.captured_at,
                    'event_type': 'terminal_command',
                    'app_name': command.shell,
                    'window_title': command.command,
                    'terminal_shell': command.shell,
                    'terminal_cwd': command.cwd,
                    'terminal_exit_code': command.exit_code,
                    'terminal_command': command.command,
                    'source': command.source,
                }
            )
        return rows

    def _record_keystroke_events(self, connection, captured_at: str, host: str, window) -> list[dict[str, object]]:
        rows: list[dict[str, object]] = []
        recorder = self._keyboard_recorder
        if recorder is None:
            return rows
        now = time.time()
        if now - self._last_keyboard_status_at >= 60:
            self._last_keyboard_status_at = now
            status_payload = dict(getattr(recorder, 'status', {}) or {})
            rows.append({
                'captured_at': captured_at,
                'username': self.username,
                'host': host,
                'event_type': 'keyboard_status',
                'app_name': 'Keyboard',
                'window_title': status_payload.get('status') or 'keyboard status',
                'window_id': getattr(window, 'window_id', None),
                'typed_text': status_payload.get('reason'),
                'key_count': status_payload.get('device_count'),
                'keys_json': serialize_keys(status_payload.get('devices') or status_payload.get('checked_paths') or []),
                'duration_seconds': None,
                'reason': status_payload.get('status'),
                'shortcut': None,
                'source': 'evdev-keyboard-chunks',
                'note': status_payload.get('reason') or 'keyboard chunk recorder status',
                **status_payload,
            })
        for event in recorder.drain_events(limit=120):
            event_type = str(event.get('type') or 'typed_chunk')
            if event_type == 'shortcut':
                row = {
                    'captured_at': event.get('ts') or captured_at,
                    'username': self.username,
                    'host': host,
                    'event_type': 'shortcut',
                    'app_name': getattr(window, 'app_name', None) or 'Keyboard',
                    'window_title': getattr(window, 'title', None) or 'keyboard shortcut',
                    'window_id': getattr(window, 'window_id', None),
                    'typed_text': None,
                    'key_count': len(event.get('keys') or []),
                    'keys_json': serialize_keys(event.get('keys')),
                    'duration_seconds': None,
                    'reason': None,
                    'shortcut': event.get('shortcut'),
                    'source': 'evdev-keyboard-chunks',
                    'note': 'keyboard shortcut captured from evdev',
                }
            else:
                row = {
                    'captured_at': event.get('end_ts') or captured_at,
                    'username': self.username,
                    'host': host,
                    'event_type': 'typed_chunk',
                    'app_name': getattr(window, 'app_name', None) or 'Keyboard',
                    'window_title': getattr(window, 'title', None) or 'typed chunk',
                    'window_id': getattr(window, 'window_id', None),
                    'typed_text': event.get('text') or '',
                    'key_count': event.get('key_count'),
                    'keys_json': serialize_keys(event.get('keys')),
                    'duration_seconds': event.get('duration_seconds'),
                    'reason': event.get('reason'),
                    'shortcut': None,
                    'source': 'evdev-keyboard-chunks',
                    'note': f"typed chunk flushed by {event.get('reason') or 'unknown'}",
                    'start_ts': event.get('start_ts'),
                    'end_ts': event.get('end_ts'),
                }
            rows.append(row)
            insert_keystroke_event(connection, row)
        return rows

    def _record_typing_activity_events(self, connection, captured_at: str, host: str) -> list[dict[str, object]]:
        rows: list[dict[str, object]] = []
        for event in self._browser_bridge.read_typing_events():
            window_id = None
            if event.window_id is not None and event.tab_id is not None:
                window_id = f'browser:{event.app_key}:window:{event.window_id}:tab:{event.tab_id}'
            typed_text = event.typed_sample_redacted or f'[browser text: {event.text_length} chars, {event.word_count} words]'
            note = 'sensitive field; content redacted' if event.sensitive else 'browser typing activity; exact text captured'
            row = {
                'captured_at': captured_at,
                'username': self.username,
                'host': host,
                'event_type': 'typing_activity',
                'app_name': event.browser,
                'window_title': event.title,
                'window_id': window_id,
                'url': event.url,
                'typed_text': typed_text,
                'key_count': event.key_count,
                'text_length': event.text_length,
                'word_count': event.word_count,
                'tag_name': event.tag_name,
                'input_type': event.input_type,
                'field_hint': event.field_hint,
                'sensitive': event.sensitive,
                'source': event.source,
                'note': note,
            }
            rows.append(row)
            insert_typing_activity_event(connection, row)
        return rows

    def _record_peripheral_snapshots(self, connection, captured_at: str, host: str) -> None:
        for device in list_peripherals():
            insert_peripheral_snapshot(
                connection,
                {
                    'captured_at': captured_at,
                    'username': self.username,
                    'host': host,
                    'device_type': device.device_type,
                    'device_id': device.device_id,
                    'name': device.name,
                    'vendor': device.vendor,
                    'model': device.model,
                    'state': device.state,
                    'source': device.source,
                },
            )

    def _record_browser_compliance_events(
        self,
        connection,
        captured_at: str,
        host: str,
        apps: dict[str, dict[str, object]],
        browser_tabs: Sequence[object],
    ) -> list[dict[str, object]]:
        rows: list[dict[str, object]] = []
        extension_keys = {getattr(tab, 'app_key', None) for tab in browser_tabs}
        browser_names = {
            'brave': 'Brave',
            'chrome': 'Google Chrome',
            'chromium': 'Chromium',
            'opera': 'Opera',
            'firefox': 'Firefox',
            'vivaldi': 'Vivaldi',
            'edge': 'Microsoft Edge',
        }
        for key, app in apps.items():
            if key not in browser_names:
                continue
            if key in extension_keys:
                status = 'extension-active'
                severity = 'ok'
                note = 'Browser extension bridge is reporting fresh tabs/clicks/audio state.'
            else:
                status = 'extension-missing-or-incognito'
                severity = 'critical'
                note = 'Browser is open but the extension bridge did not report tabs/fresh tabs. Possible extension missing, disabled, incognito/private, unsupported, or portable browser without policy coverage.'
            row = {
                'captured_at': captured_at,
                'username': self.username,
                'host': host,
                'event_type': 'browser_compliance',
                'app_name': browser_names[key],
                'window_title': f'{browser_names[key]} extension safety',
                'browser_key': key,
                'browser_name': browser_names[key],
                'pid': app.get('pid'),
                'process_name': app.get('process_name'),
                'command_line': app.get('command_line'),
                'status': status,
                'severity': severity,
                'note': note,
                'source': 'native-browser-safety-check',
            }
            rows.append(row)
            insert_browser_compliance_event(connection, row)
        return rows

    def _enrich_audio_output(self, row: dict[str, object]) -> dict[str, object]:
        if row.get('content_title') or row.get('mpris_title'):
            return row
        app = str(row.get('application_name') or row.get('process_binary') or '').lower()
        browser_keys = {
            'brave': ('brave', 'brave-browser', 'brave-browser-stable'),
            'chrome': ('chrome', 'google chrome', 'google-chrome', 'google-chrome-stable'),
            'chromium': ('chromium', 'chromium-browser'),
            'firefox': ('firefox', 'librewolf'),
            'edge': ('edge', 'microsoft edge'),
        }
        wanted_keys = [key for key, aliases in browser_keys.items() if any(alias in app for alias in aliases)]
        if not wanted_keys:
            return row
        tabs = [tab for tab in self._browser_bridge.current_tabs(max_age_seconds=30) if tab.app_key in wanted_keys]
        audible_tab = next((tab for tab in tabs if tab.audible and tab.title), None)
        active_audible_tab = next((tab for tab in tabs if tab.audible and tab.active and tab.title), None)
        active_tab = next((tab for tab in tabs if tab.active and tab.title), None)
        tab = active_audible_tab or audible_tab or active_tab
        if tab is not None:
            row['content_title'] = tab.title
            row['content_url'] = tab.url
        return row

    def _record_audio_outputs(self, connection, captured_at: str, host: str) -> list[dict[str, object]]:
        rows: list[dict[str, object]] = []
        for audio in list_audio_outputs():
            row = {
                    'captured_at': captured_at,
                    'username': self.username,
                    'host': host,
                    'sink_input_id': audio.sink_input_id,
                    'application_name': audio.application_name,
                    'process_id': audio.process_id,
                    'process_binary': audio.process_binary,
                    'media_name': audio.media_name,
                    'node_name': audio.node_name,
                    'corked': audio.corked,
                    'mute': audio.mute,
                    'volume': audio.volume,
                    'state_hint': audio.state_hint,
                    'mpris_player': audio.mpris_player,
                    'mpris_title': audio.mpris_title,
                    'mpris_artist': audio.mpris_artist,
                    'mpris_album': audio.mpris_album,
                    'mpris_status': audio.mpris_status,
                    'source': audio.source,
                }
            row = self._enrich_audio_output(row)
            rows.append(row)
            insert_audio_output_snapshot(
                connection,
                row,
            )
        return rows

    def _delete_uploaded_screenshot_file(self, screenshot_path: str | None) -> bool:
        if not screenshot_path:
            return False
        try:
            path = Path(screenshot_path)
            if path.exists() and path.is_file() and path.resolve().is_relative_to(self.screenshot_dir.resolve()):
                path.unlink(missing_ok=True)
                return True
        except OSError:
            return False
        return False

    def _cleanup_local_cache(self, connection, captured_at: str, upload_ok: bool, screenshot_path: str | None) -> dict[str, object]:
        if upload_ok:
            self._delete_uploaded_screenshot_file(screenshot_path)
            retention = self.local_success_retention_seconds
        else:
            retention = self.local_failed_retention_seconds
        now = time.monotonic()
        if self._last_local_cleanup_at and (now - self._last_local_cleanup_at) < self.local_cleanup_interval_seconds:
            return {
                'skipped': 'cleanup_interval_not_elapsed',
                'next_cleanup_in_seconds': max(0, self.local_cleanup_interval_seconds - (now - self._last_local_cleanup_at)),
                'upload_ok': upload_ok,
            }
        try:
            cutoff_dt = datetime.fromisoformat(captured_at.replace('Z', '+00:00')) - timedelta(seconds=retention)
            cutoff = cutoff_dt.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
        except ValueError:
            cutoff = captured_at if upload_ok else datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        deleted_rows = prune_local_telemetry(connection, cutoff)
        self._last_local_cleanup_at = now
        return {'cutoff': cutoff, 'deleted_rows': deleted_rows, 'upload_ok': upload_ok}

    def run_once(self, connection, host: str | None = None) -> dict[str, object]:
        host = host or host_name()
        now = time.time()
        captured_at = datetime.now(timezone.utc).isoformat()

        file_change_events: list[dict[str, object]] = []
        auto_update_events = self._auto_updater.drain_events(captured_at, self.username, host)

        self._browser_bridge.ingest_gnome_state_file()
        current_processes: list[object] = list(self._process_state.values())
        if (now - self._last_process_scan_at) >= self.process_scan_interval_seconds:
            current_processes = self._record_process_snapshot(connection, captured_at, host)
            self._record_peripheral_snapshots(connection, captured_at, host)
            self._last_process_scan_at = now

        if (now - self._last_file_scan_at) >= self.file_scan_interval_seconds:
            root_batch = self._next_file_root_batch(current_processes)
            file_change_events = self._record_workspace_snapshot(connection, captured_at, host, current_processes, roots=root_batch)
            self._last_file_scan_at = now

        state_snapshot_fresh = (now - self._last_state_snapshot_at) >= self.state_snapshot_interval_seconds
        if state_snapshot_fresh:
            windows = self._record_window_snapshot(connection, captured_at, host)
            self._record_warp_activity(connection, captured_at, host, current_processes, windows)
            open_state = self._record_current_open_state(connection, captured_at, host, current_processes, windows)
            self._cached_windows = windows
            self._cached_open_state = open_state
            self._last_state_snapshot_at = now
        else:
            windows = self._cached_windows
            # Keep using the cached windows for click attribution, but do not re-upload
            # repeated current-open-state rows every lightweight tick. Dedicated current
            # snapshot tables and rich logs refresh on the state cadence above.
            open_state = {'open_apps': [], 'subwindows': [], 'browser_compliance_events': []}
        focus_events = self._record_browser_focus_events(connection, captured_at, host)

        window = current_window_info()
        gnome_window = self._browser_bridge.active_gnome_window()
        if gnome_window is not None:
            window = SimpleNamespace(
                window_id=gnome_window.window_id,
                title=gnome_window.title,
                app_name=gnome_window.app_name,
                pid=gnome_window.pid,
                wm_class=gnome_window.wm_class,
            )
        browser_tab = self._browser_bridge.active_tab()
        if browser_tab is not None:
            window = SimpleNamespace(
                window_id=f'browser:{browser_tab.app_key}:window:{browser_tab.window_id}:tab:{browser_tab.tab_id}',
                title=f'{browser_tab.title or "Untitled browser tab"} — {browser_tab.url or ""}',
                app_name=browser_tab.browser,
                pid=None,
                wm_class=browser_tab.app_key,
            )
        self._record_window_focus_event(connection, captured_at, host, window)
        click_events = self._record_click_events(connection, captured_at, host, window, windows)
        terminal_command_events = self._record_terminal_command_events()
        clipboard_events = self._record_clipboard_event(connection, captured_at, host, window)
        typing_activity_events = self._record_typing_activity_events(connection, captured_at, host)
        keystroke_events = self._record_keystroke_events(connection, captured_at, host, window)
        activity_session_events = build_activity_session_events(
            captured_at=captured_at,
            typing_rows=typing_activity_events,
            click_rows=click_events,
        )
        audio_outputs = self._record_audio_outputs(connection, captured_at, host) if self.enable_audio_outputs else []
        screenshot_path = None
        screenshot_image_base64 = None
        screenshot_mime_type = None
        screenshot_log = None
        idle_value = idle_seconds()
        if self.enable_screenshots and (now - self._last_screenshot_at) >= self.screenshot_interval_seconds:
            self._last_screenshot_at = now
            if idle_value > self.screenshot_activity_idle_seconds:
                screenshot_log = {
                    'captured_at': captured_at,
                    'event_type': 'screenshot_capture',
                    'app_name': window.app_name,
                    'window_title': window.title,
                    'window_id': window.window_id,
                    'status': 'skipped',
                    'backend': None,
                    'reason': 'idle_outside_active_work',
                    'idle_seconds': idle_value,
                    'uploaded': False,
                    'username': self.username,
                    'host': host,
                }
            else:
                screenshot_result = capture_screenshot_with_status(self.screenshot_dir, self.username, window.window_id)
                screenshot = screenshot_result.path
                screenshot_path = str(screenshot) if screenshot else None
                screenshot_log = {
                    'captured_at': captured_at,
                    'event_type': 'screenshot_capture',
                    'app_name': window.app_name,
                    'window_title': window.title,
                    'window_id': window.window_id,
                    'status': screenshot_result.status,
                    'backend': screenshot_result.backend,
                    'reason': screenshot_result.reason,
                    'attempts': list(screenshot_result.attempts),
                    'screenshot_path': screenshot_path,
                    'uploaded': False,
                    'username': self.username,
                    'host': host,
                }
                if screenshot and screenshot.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp'}:
                    similarity = screenshot_similarity(self._last_uploaded_screenshot_path, screenshot)
                    if similarity is not None and similarity >= self.screenshot_similarity_threshold:
                        try:
                            screenshot.unlink(missing_ok=True)
                        except OSError:
                            pass
                        screenshot_path = None
                        screenshot_log.update({
                            'status': 'skipped',
                            'reason': 'similar_to_previous_screenshot',
                            'similarity': similarity,
                            'screenshot_path': None,
                            'uploaded': False,
                        })
                    else:
                        try:
                            screenshot_image_base64 = base64.b64encode(screenshot.read_bytes()).decode('ascii')
                            screenshot_mime_type = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'}[screenshot.suffix.lower()]
                            screenshot_log['uploaded'] = True
                            screenshot_log['mime_type'] = screenshot_mime_type
                            self._last_uploaded_screenshot_path = screenshot
                        except OSError as exc:
                            screenshot_image_base64 = None
                            screenshot_mime_type = None
                            screenshot_log['status'] = 'captured_local_read_failed'
                            screenshot_log['reason'] = str(exc)
                if screenshot_image_base64 is None and screenshot_log.get('reason') != 'similar_to_previous_screenshot' and browser_tab is not None:
                    browser_screenshot = self._browser_bridge.latest_screenshot(browser_tab)
                    decoded = _decode_browser_screenshot(browser_screenshot.data_url) if browser_screenshot is not None else None
                    if decoded is not None and browser_screenshot is not None:
                        image_bytes, mime_type, extension = decoded
                        browser_path = self.screenshot_dir / f'{self.username}_browser_tab_{int(now)}{extension}'
                        try:
                            browser_path.write_bytes(image_bytes)
                            similarity = screenshot_similarity(self._last_uploaded_screenshot_path, browser_path)
                            if similarity is not None and similarity >= self.screenshot_similarity_threshold:
                                browser_path.unlink(missing_ok=True)
                                screenshot_path = None
                                screenshot_log.update({
                                    'status': 'skipped',
                                    'backend': 'browser_extension_capture_visible_tab',
                                    'reason': 'similar_to_previous_screenshot',
                                    'similarity': similarity,
                                    'attempts': list(screenshot_result.attempts) + ['browser_extension_capture_visible_tab'],
                                    'screenshot_path': None,
                                    'uploaded': False,
                                    'source': browser_screenshot.source,
                                })
                            else:
                                screenshot_path = str(browser_path)
                                screenshot_image_base64 = base64.b64encode(image_bytes).decode('ascii')
                                screenshot_mime_type = mime_type
                                self._last_uploaded_screenshot_path = browser_path
                                screenshot_log.update({
                                    'status': 'captured',
                                    'backend': 'browser_extension_capture_visible_tab',
                                    'reason': None,
                                    'attempts': list(screenshot_result.attempts) + ['browser_extension_capture_visible_tab'],
                                    'screenshot_path': screenshot_path,
                                    'uploaded': True,
                                    'mime_type': mime_type,
                                    'source': browser_screenshot.source,
                                })
                        except OSError as exc:
                            screenshot_log['reason'] = f"browser_extension_capture_failed: {exc}"
            insert_screenshot_event(connection, screenshot_log)

        screenshot_events = [screenshot_log] if screenshot_log else []
        browser_compliance_events = open_state.get('browser_compliance_events', [])

        rich_events = (
            [{**row, 'event_type': 'app_open'} for row in open_state.get('open_apps', [])]
            + [{**row, 'event_type': 'browser_tab' if row.get('subwindow_type') == 'tab' else 'app_subwindow'} for row in open_state.get('subwindows', [])]
            + [{**row, 'event_type': 'window_focus'} for row in focus_events]
            + [{**row, 'event_type': 'input_click'} for row in click_events]
            + terminal_command_events
            + clipboard_events
            + [{**row, 'event_type': 'typing_activity'} for row in typing_activity_events]
            + keystroke_events
            + activity_session_events
            + screenshot_events
            + [{**row, 'event_type': 'browser_compliance'} for row in browser_compliance_events]
            + [{**row, 'event_type': 'audio_output'} for row in audio_outputs]
            + file_change_events
            + [{**row, 'event_type': 'auto_update_status'} for row in auto_update_events]
        )

        activity_payload = {
            'captured_at': captured_at,
            'username': self.username,
            'host': host,
            'hostname': host,
            'os_user': self.username,
            'window_id': window.window_id,
            'window_title': window.title,
            'app_name': window.app_name,
            'window_pid': window.pid,
            'window_class': window.wm_class,
            'idle_seconds': idle_value,
            'screenshot_path': screenshot_path,
            'event_type': 'activity_snapshot',
            'rich_logs': {
                'open_apps': open_state.get('open_apps', [])[:80],
                'subwindows': open_state.get('subwindows', [])[:120],
                'focus_events': focus_events[:80],
                'click_events': click_events[:120],
                'terminal_commands': terminal_command_events[:120],
                'clipboard_events': clipboard_events[:20],
                'typing_activity': typing_activity_events[:120],
                'keystrokes': keystroke_events[:120],
                'activity_sessions': activity_session_events[:120],
                'screenshot_events': screenshot_events[:20],
                'browser_compliance_events': browser_compliance_events[:80],
                'audio_outputs': audio_outputs[:80],
                'file_changes': file_change_events[:120],
                'auto_update_events': auto_update_events[:20],
            },
            'rich_events': rich_events[:250],
        }
        if screenshot_image_base64 and screenshot_mime_type:
            # Keep legacy key name for the server route, but send the actual MIME type.
            activity_payload['screenshot_png_base64'] = screenshot_image_base64
            activity_payload['screenshot_mime_type'] = screenshot_mime_type
        resource_usage_event = collect_resource_usage(connection, username=self.username, host=host)
        insert_resource_usage_snapshot(connection, resource_usage_event)
        activity_payload['rich_events'] = (activity_payload.get('rich_events') or []) + [resource_usage_event]
        activity_payload['rich_logs']['resource_usage'] = [resource_usage_event]

        insert_activity(connection, activity_payload)
        cloud_enabled = self._cloud_uploader.enabled
        if cloud_enabled and self._cloud_uploader.settings is not None:
            enqueue_cloud_payload(
                connection,
                activity_payload,
                max_rows=self._cloud_uploader.settings.max_queue_rows,
                max_bytes=self._cloud_uploader.settings.max_queue_bytes,
            )
            drain_result = self._cloud_uploader.drain_queue(connection)
            cloud_upload_ok = drain_result.uploaded > 0 and drain_result.failed == 0
            activity_payload['_cloud_upload_ok'] = cloud_upload_ok
            activity_payload['_cloud_queue_drain'] = {
                'attempted': drain_result.attempted,
                'uploaded': drain_result.uploaded,
                'failed': drain_result.failed,
                'remaining': drain_result.remaining,
            }
            if cloud_upload_ok:
                activity_payload['_local_cleanup'] = self._cleanup_local_cache(
                    connection,
                    captured_at,
                    True,
                    screenshot_path,
                )
            else:
                activity_payload['_local_cleanup'] = {'skipped': 'cloud_queue_not_fully_drained'}
        else:
            activity_payload['_cloud_upload_ok'] = False
            activity_payload['_local_cleanup'] = {'skipped': 'cloud_upload_not_configured'}
        return activity_payload

    def run_forever(self) -> None:
        host = host_name()
        with connect(self.db_path) as connection:
            while True:
                self._auto_updater.maybe_check()
                self.run_once(connection, host)
                time.sleep(self.poll_interval_seconds)
