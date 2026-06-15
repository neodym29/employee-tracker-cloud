from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
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

from .browser_bridge import BrowserBridge
from .cloud import CloudUploader, load_cloud_settings
from .db import (
    connect,
    fetch_file_state_rows,
    insert_activity,
    insert_current_app_snapshot,
    insert_current_subwindow_snapshot,
    insert_file_event,
    insert_input_click_event,
    insert_typing_activity_event,
    insert_window_focus_event,
    insert_audio_output_snapshot,
    insert_browser_compliance_event,
    insert_peripheral_snapshot,
    insert_process_lifecycle_event,
    insert_process_snapshot,
    insert_warp_activity_snapshot,
    insert_window_snapshot,
    mark_file_deleted,
    upsert_file_state,
)
from .screenshots import capture_screenshot
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
from .workspace import scan_workspace


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
        file_scan_interval_seconds: int = 30,
        process_scan_interval_seconds: int = 30,
        enable_screenshots: bool = True,
    ) -> None:
        self.db_path = db_path
        self.screenshot_dir = screenshot_dir
        self.workspace_dir = workspace_dir.resolve()
        self.file_roots = tuple(dict.fromkeys((root.expanduser().resolve() for root in (file_roots or (self.workspace_dir,)))))
        self.username = username
        self.poll_interval_seconds = poll_interval_seconds
        self.screenshot_interval_seconds = screenshot_interval_seconds
        self.file_scan_interval_seconds = file_scan_interval_seconds
        self.process_scan_interval_seconds = process_scan_interval_seconds
        self.enable_screenshots = enable_screenshots
        self._last_screenshot_at: float = 0.0
        # Do not block first cloud connection on a potentially large home-directory scan.
        self._last_file_scan_at: float = time.time()
        self._last_process_scan_at: float = 0.0
        self._workspace_root = str(self.workspace_dir)
        self._file_roots = tuple(str(root) for root in self.file_roots)
        self._file_state = self._load_file_state()
        self._process_state: dict[int, object] = {}
        self._last_window = None
        self._click_reader = XInputClickReader()
        self._terminal_command_reader = TerminalCommandReader()
        self._browser_bridge = BrowserBridge()
        self._browser_bridge.start()
        self._cloud_uploader = CloudUploader(load_cloud_settings())

    def _load_file_state(self) -> dict[tuple[str, str], dict[str, object]]:
        state: dict[tuple[str, str], dict[str, object]] = {}
        tracked_roots = set(self._file_roots)
        for row in fetch_file_state_rows(self.db_path):
            workspace_root = row['workspace_root']
            if workspace_root not in tracked_roots:
                continue
            state[(workspace_root, row['relative_path'])] = dict(row)
        return state

    def _record_workspace_snapshot(self, connection, captured_at: str, host: str) -> None:
        for file_root in self.file_roots:
            self._record_file_root_snapshot(connection, captured_at, host, file_root)

    def _record_file_root_snapshot(self, connection, captured_at: str, host: str, file_root: Path) -> None:
        root = file_root.resolve()
        workspace_root = str(root)
        previous_by_relative_path = {
            key[1]: value for key, value in self._file_state.items() if key[0] == workspace_root
        }
        snapshots = scan_workspace(root, previous_state=previous_by_relative_path)
        current_paths: set[str] = set()
        baseline_mode = not any(key[0] == workspace_root for key in self._file_state)

        for snapshot in snapshots:
            state_key = (workspace_root, snapshot.relative_path)
            current_paths.add(snapshot.relative_path)
            previous = self._file_state.get(state_key)
            if previous is None:
                event_type = 'baseline' if baseline_mode else 'created'
                note = 'initial file inventory' if baseline_mode else 'file added to tracked root'
                insert_file_event(
                    connection,
                    {
                        'captured_at': captured_at,
                        'username': self.username,
                        'host': host,
                        'workspace_root': workspace_root,
                        'absolute_path': snapshot.absolute_path,
                        'relative_path': snapshot.relative_path,
                        'event_type': event_type,
                        'previous_size': None,
                        'previous_line_count': None,
                        'previous_sha256': None,
                        'file_size': snapshot.file_size,
                        'line_count': snapshot.line_count,
                        'sha256': snapshot.sha256,
                        'language': snapshot.language,
                        'note': note,
                    },
                )
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
                    insert_file_event(
                        connection,
                        {
                            'captured_at': captured_at,
                            'username': self.username,
                            'host': host,
                            'workspace_root': workspace_root,
                            'absolute_path': snapshot.absolute_path,
                            'relative_path': snapshot.relative_path,
                            'event_type': 'modified',
                            'previous_size': previous_size,
                            'previous_line_count': previous_line_count,
                            'previous_sha256': previous_sha256,
                            'file_size': current_size,
                            'line_count': current_line_count,
                            'sha256': current_sha256,
                            'language': snapshot.language,
                            'note': '; '.join(note_parts),
                        },
                    )

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
            insert_file_event(
                connection,
                {
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
                },
            )
            mark_file_deleted(connection, workspace_root, relative_path, captured_at)
            del self._file_state[state_key]

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

        self._record_browser_compliance_events(connection, captured_at, host, app_rows, browser_tabs)

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
        return {'open_apps': list(app_rows.values()), 'subwindows': subwindow_rows}


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

    def _record_typing_activity_events(self, connection, captured_at: str, host: str) -> list[dict[str, object]]:
        rows: list[dict[str, object]] = []
        for event in self._browser_bridge.read_typing_events():
            window_id = None
            if event.window_id is not None and event.tab_id is not None:
                window_id = f'browser:{event.app_key}:window:{event.window_id}:tab:{event.tab_id}'
            typed_text = event.typed_sample_redacted or f'[redacted browser text: {event.text_length} chars, {event.word_count} words]'
            note = 'sensitive field; content redacted' if event.sensitive else 'browser typing activity; text content redacted'
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
        browser_tabs: list[object],
    ) -> None:
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
                note = 'Browser extension bridge is reporting tabs/clicks/audio state.'
            else:
                status = 'extension-missing-or-incognito'
                severity = 'critical'
                note = 'Browser is open but the extension bridge did not report tabs. Possible missing extension, disabled extension, unsupported browser, or incognito/private window without extension access.'
            insert_browser_compliance_event(
                connection,
                {
                    'captured_at': captured_at,
                    'username': self.username,
                    'host': host,
                    'browser_key': key,
                    'browser_name': browser_names[key],
                    'pid': app.get('pid'),
                    'process_name': app.get('process_name'),
                    'command_line': None,
                    'status': status,
                    'severity': severity,
                    'note': note,
                },
            )

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

    def run_once(self, connection, host: str | None = None) -> dict[str, object]:
        host = host or host_name()
        now = time.time()
        captured_at = datetime.now(timezone.utc).isoformat()

        if (now - self._last_file_scan_at) >= self.file_scan_interval_seconds:
            self._record_workspace_snapshot(connection, captured_at, host)
            self._last_file_scan_at = now

        self._browser_bridge.ingest_gnome_state_file()
        current_processes: list[object] = list(self._process_state.values())
        if (now - self._last_process_scan_at) >= self.process_scan_interval_seconds:
            current_processes = self._record_process_snapshot(connection, captured_at, host)
            self._record_peripheral_snapshots(connection, captured_at, host)
            self._last_process_scan_at = now

        windows = self._record_window_snapshot(connection, captured_at, host)
        self._record_warp_activity(connection, captured_at, host, current_processes, windows)
        open_state = self._record_current_open_state(connection, captured_at, host, current_processes, windows)
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
        typing_activity_events = self._record_typing_activity_events(connection, captured_at, host)
        activity_session_events = build_activity_session_events(
            captured_at=captured_at,
            typing_rows=typing_activity_events,
            click_rows=click_events,
        )
        audio_outputs = self._record_audio_outputs(connection, captured_at, host)
        screenshot_path = None
        screenshot_image_base64 = None
        screenshot_mime_type = None
        if self.enable_screenshots and (now - self._last_screenshot_at) >= self.screenshot_interval_seconds:
            screenshot = capture_screenshot(self.screenshot_dir, self.username, window.window_id)
            screenshot_path = str(screenshot) if screenshot else None
            if screenshot and screenshot.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp'}:
                try:
                    screenshot_image_base64 = base64.b64encode(screenshot.read_bytes()).decode('ascii')
                    screenshot_mime_type = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'}[screenshot.suffix.lower()]
                except OSError:
                    screenshot_image_base64 = None
                    screenshot_mime_type = None
            self._last_screenshot_at = now

        rich_events = (
            [{**row, 'event_type': 'app_open'} for row in open_state.get('open_apps', [])]
            + [{**row, 'event_type': 'browser_tab' if row.get('subwindow_type') == 'tab' else 'app_subwindow'} for row in open_state.get('subwindows', [])]
            + [{**row, 'event_type': 'window_focus'} for row in focus_events]
            + [{**row, 'event_type': 'input_click'} for row in click_events]
            + terminal_command_events
            + [{**row, 'event_type': 'typing_activity'} for row in typing_activity_events]
            + activity_session_events
            + [{**row, 'event_type': 'audio_output'} for row in audio_outputs]
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
            'idle_seconds': idle_seconds(),
            'screenshot_path': screenshot_path,
            'event_type': 'activity_snapshot',
            'rich_logs': {
                'open_apps': open_state.get('open_apps', [])[:80],
                'subwindows': open_state.get('subwindows', [])[:120],
                'focus_events': focus_events[:80],
                'click_events': click_events[:120],
                'terminal_commands': terminal_command_events[:120],
                'typing_activity': typing_activity_events[:120],
                'activity_sessions': activity_session_events[:120],
                'audio_outputs': audio_outputs[:80],
            },
            'rich_events': rich_events[:250],
        }
        if screenshot_image_base64 and screenshot_mime_type:
            # Keep legacy key name for the server route, but send the actual MIME type.
            activity_payload['screenshot_png_base64'] = screenshot_image_base64
            activity_payload['screenshot_mime_type'] = screenshot_mime_type
        insert_activity(connection, activity_payload)
        cloud_upload_ok = self._cloud_uploader.upload_activity(activity_payload)
        activity_payload['_cloud_upload_ok'] = cloud_upload_ok
        return activity_payload

    def run_forever(self) -> None:
        host = host_name()
        with connect(self.db_path) as connection:
            while True:
                self.run_once(connection, host)
                time.sleep(self.poll_interval_seconds)
