from __future__ import annotations

from pathlib import Path
import json
import sqlite3
from typing import Any


LOCAL_TELEMETRY_TABLES = (
    'activity_snapshots',
    'screenshot_events',
    'window_snapshots',
    'warp_activity_snapshots',
    'current_app_snapshots',
    'current_subwindow_snapshots',
    'file_activity_events',
    'process_snapshots',
    'process_lifecycle_events',
    'input_click_events',
    'window_focus_events',
    'audio_output_snapshots',
    'peripheral_snapshots',
    'browser_compliance_events',
    'keystroke_events',
)



SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS activity_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    window_id TEXT,
    window_title TEXT,
    app_name TEXT,
    window_pid INTEGER,
    window_class TEXT,
    idle_seconds INTEGER NOT NULL DEFAULT 0,
    screenshot_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_snapshots_user_time
    ON activity_snapshots(username, captured_at DESC);

CREATE TABLE IF NOT EXISTS screenshot_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    window_id TEXT,
    window_title TEXT,
    app_name TEXT,
    status TEXT NOT NULL,
    backend TEXT,
    reason TEXT,
    attempts_json TEXT,
    screenshot_path TEXT,
    uploaded INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT
);

CREATE INDEX IF NOT EXISTS idx_screenshot_events_user_time
    ON screenshot_events(username, captured_at DESC);

CREATE TABLE IF NOT EXISTS window_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    window_id TEXT NOT NULL,
    window_title TEXT,
    app_name TEXT,
    window_pid INTEGER,
    window_class TEXT,
    is_active INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_window_snapshots_user_time
    ON window_snapshots(username, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_window_snapshots_window_time
    ON window_snapshots(window_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS warp_activity_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    warp_pid INTEGER NOT NULL,
    shell_pid INTEGER,
    observed_pid INTEGER,
    observed_process_name TEXT,
    observed_command_line TEXT,
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_warp_activity_user_time
    ON warp_activity_snapshots(username, captured_at DESC);

CREATE TABLE IF NOT EXISTS current_app_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    app_key TEXT NOT NULL,
    app_name TEXT NOT NULL,
    pid INTEGER,
    process_name TEXT,
    window_count INTEGER NOT NULL DEFAULT 0,
    subwindow_count INTEGER NOT NULL DEFAULT 0,
    source TEXT
);

CREATE INDEX IF NOT EXISTS idx_current_app_snapshots_user_time
    ON current_app_snapshots(username, captured_at DESC);

CREATE TABLE IF NOT EXISTS current_subwindow_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    app_key TEXT NOT NULL,
    app_name TEXT NOT NULL,
    subwindow_type TEXT NOT NULL,
    title TEXT,
    url TEXT,
    window_id TEXT,
    pid INTEGER,
    is_active INTEGER NOT NULL DEFAULT 0,
    source TEXT
);

CREATE INDEX IF NOT EXISTS idx_current_subwindow_snapshots_user_time
    ON current_subwindow_snapshots(username, captured_at DESC);

CREATE TABLE IF NOT EXISTS file_activity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    event_type TEXT NOT NULL,
    previous_size INTEGER,
    previous_line_count INTEGER,
    previous_sha256 TEXT,
    file_size INTEGER,
    line_count INTEGER,
    sha256 TEXT,
    language TEXT,
    note TEXT,
    content_status TEXT,
    content_encoding TEXT,
    content_text TEXT,
    content_truncated INTEGER NOT NULL DEFAULT 0,
    content_redacted INTEGER NOT NULL DEFAULT 0,
    content_bytes_read INTEGER,
    content_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_file_activity_events_user_time
    ON file_activity_events(username, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_file_activity_events_workspace_time
    ON file_activity_events(workspace_root, captured_at DESC);

CREATE TABLE IF NOT EXISTS file_state (
    workspace_root TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    file_size INTEGER,
    mtime_ns INTEGER,
    line_count INTEGER,
    sha256 TEXT,
    language TEXT,
    last_seen_at TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY (workspace_root, relative_path)
);

CREATE TABLE IF NOT EXISTS process_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    pid INTEGER NOT NULL,
    ppid INTEGER,
    process_name TEXT,
    exe_path TEXT,
    cwd TEXT,
    command_line TEXT,
    state TEXT,
    uid INTEGER,
    process_username TEXT,
    start_time_ticks INTEGER
);

CREATE INDEX IF NOT EXISTS idx_process_snapshots_user_time
    ON process_snapshots(username, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_process_snapshots_pid_time
    ON process_snapshots(pid, captured_at DESC);

CREATE TABLE IF NOT EXISTS process_lifecycle_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    event_type TEXT NOT NULL,
    pid INTEGER NOT NULL,
    ppid INTEGER,
    process_name TEXT,
    exe_path TEXT,
    cwd TEXT,
    command_line TEXT,
    state TEXT,
    uid INTEGER,
    process_username TEXT,
    start_time_ticks INTEGER,
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_process_lifecycle_events_user_time
    ON process_lifecycle_events(username, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_process_lifecycle_events_pid_time
    ON process_lifecycle_events(pid, captured_at DESC);

CREATE TABLE IF NOT EXISTS input_click_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    button INTEGER,
    x REAL,
    y REAL,
    screen_x REAL,
    screen_y REAL,
    window_id TEXT,
    window_title TEXT,
    app_name TEXT,
    window_pid INTEGER,
    window_class TEXT,
    target_hint TEXT,
    source TEXT
);

CREATE INDEX IF NOT EXISTS idx_input_click_events_user_time
    ON input_click_events(username, captured_at DESC);

CREATE TABLE IF NOT EXISTS window_focus_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    from_window_id TEXT,
    from_window_title TEXT,
    from_app_name TEXT,
    to_window_id TEXT,
    to_window_title TEXT,
    to_app_name TEXT,
    to_window_pid INTEGER,
    to_window_class TEXT,
    reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_window_focus_events_user_time
    ON window_focus_events(username, captured_at DESC);

CREATE TABLE IF NOT EXISTS audio_output_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    sink_input_id TEXT,
    application_name TEXT,
    process_id INTEGER,
    process_binary TEXT,
    media_name TEXT,
    node_name TEXT,
    corked TEXT,
    mute TEXT,
    volume TEXT,
    state_hint TEXT,
    mpris_player TEXT,
    mpris_title TEXT,
    mpris_artist TEXT,
    mpris_album TEXT,
    mpris_status TEXT,
    content_title TEXT,
    content_url TEXT,
    source TEXT
);

CREATE INDEX IF NOT EXISTS idx_audio_output_snapshots_user_time
    ON audio_output_snapshots(username, captured_at DESC);

CREATE TABLE IF NOT EXISTS peripheral_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    device_type TEXT NOT NULL,
    device_id TEXT,
    name TEXT,
    vendor TEXT,
    model TEXT,
    state TEXT,
    source TEXT
);

CREATE INDEX IF NOT EXISTS idx_peripheral_snapshots_user_time
    ON peripheral_snapshots(username, captured_at DESC);

CREATE TABLE IF NOT EXISTS browser_compliance_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    browser_key TEXT NOT NULL,
    browser_name TEXT NOT NULL,
    pid INTEGER,
    process_name TEXT,
    command_line TEXT,
    status TEXT NOT NULL,
    severity TEXT NOT NULL,
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_browser_compliance_user_time
    ON browser_compliance_events(username, captured_at DESC);

CREATE TABLE IF NOT EXISTS keystroke_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    app_name TEXT,
    window_title TEXT,
    window_id TEXT,
    typed_text TEXT,
    key_count INTEGER,
    source TEXT,
    note TEXT,
    keys_json TEXT,
    duration_seconds REAL,
    reason TEXT,
    shortcut TEXT
);

CREATE INDEX IF NOT EXISTS idx_keystroke_events_user_time
    ON keystroke_events(username, captured_at DESC);


CREATE TABLE IF NOT EXISTS clipboard_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    app_name TEXT,
    window_title TEXT,
    window_id TEXT,
    content_text TEXT,
    content_hash TEXT,
    content_length INTEGER,
    content_redacted INTEGER NOT NULL DEFAULT 0,
    content_truncated INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    status TEXT,
    reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_clipboard_events_user_time
    ON clipboard_events(username, captured_at DESC);
"""


KEYSTROKE_SCHEMA_ALTERS = {
    'keys_json': 'ALTER TABLE keystroke_events ADD COLUMN keys_json TEXT',
    'duration_seconds': 'ALTER TABLE keystroke_events ADD COLUMN duration_seconds REAL',
    'reason': 'ALTER TABLE keystroke_events ADD COLUMN reason TEXT',
    'shortcut': 'ALTER TABLE keystroke_events ADD COLUMN shortcut TEXT',
}


FILE_ACTIVITY_SCHEMA_ALTERS = {
    'content_status': 'ALTER TABLE file_activity_events ADD COLUMN content_status TEXT',
    'content_encoding': 'ALTER TABLE file_activity_events ADD COLUMN content_encoding TEXT',
    'content_text': 'ALTER TABLE file_activity_events ADD COLUMN content_text TEXT',
    'content_truncated': 'ALTER TABLE file_activity_events ADD COLUMN content_truncated INTEGER NOT NULL DEFAULT 0',
    'content_redacted': 'ALTER TABLE file_activity_events ADD COLUMN content_redacted INTEGER NOT NULL DEFAULT 0',
    'content_bytes_read': 'ALTER TABLE file_activity_events ADD COLUMN content_bytes_read INTEGER',
    'content_reason': 'ALTER TABLE file_activity_events ADD COLUMN content_reason TEXT',
}


AUDIO_OUTPUT_SCHEMA_ALTERS = {
    'mpris_player': 'ALTER TABLE audio_output_snapshots ADD COLUMN mpris_player TEXT',
    'mpris_title': 'ALTER TABLE audio_output_snapshots ADD COLUMN mpris_title TEXT',
    'mpris_artist': 'ALTER TABLE audio_output_snapshots ADD COLUMN mpris_artist TEXT',
    'mpris_album': 'ALTER TABLE audio_output_snapshots ADD COLUMN mpris_album TEXT',
    'mpris_status': 'ALTER TABLE audio_output_snapshots ADD COLUMN mpris_status TEXT',
    'content_title': 'ALTER TABLE audio_output_snapshots ADD COLUMN content_title TEXT',
    'content_url': 'ALTER TABLE audio_output_snapshots ADD COLUMN content_url TEXT',
}


AUDIO_OUTPUT_SCHEMA_COLUMNS = tuple(AUDIO_OUTPUT_SCHEMA_ALTERS)


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.executescript(
        """
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        PRAGMA busy_timeout=30000;
        PRAGMA temp_store=MEMORY;
        """
    )
    return connection


def init_db(db_path: Path) -> None:
    with connect(db_path) as connection:
        connection.executescript(SCHEMA)
        _migrate_keystroke_schema(connection)
        _migrate_file_activity_schema(connection)
        _migrate_audio_output_schema(connection)


def prune_local_telemetry(connection: sqlite3.Connection, captured_at_cutoff: str) -> int:
    """Delete locally cached telemetry rows at or before the cutoff.

    Cloud mode uses SQLite only as a tiny transient staging/cache layer. Keep
    file_state because it is the dedupe baseline, but purge every append-only
    telemetry table once data has been accepted by Supabase.
    """
    deleted = 0
    for table in LOCAL_TELEMETRY_TABLES:
        cursor = connection.execute(f'DELETE FROM {table} WHERE captured_at <= ?', (captured_at_cutoff,))
        deleted += cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0
    connection.commit()
    try:
        connection.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    except sqlite3.DatabaseError:
        pass
    return deleted


def _migrate_keystroke_schema(connection: sqlite3.Connection) -> None:
    existing = {row['name'] for row in connection.execute('PRAGMA table_info(keystroke_events)').fetchall()}
    for column, statement in KEYSTROKE_SCHEMA_ALTERS.items():
        if column not in existing:
            connection.execute(statement)
    connection.commit()


def _migrate_file_activity_schema(connection: sqlite3.Connection) -> None:
    existing = {row['name'] for row in connection.execute('PRAGMA table_info(file_activity_events)').fetchall()}
    for column, statement in FILE_ACTIVITY_SCHEMA_ALTERS.items():
        if column not in existing:
            connection.execute(statement)
    connection.commit()


def _migrate_audio_output_schema(connection: sqlite3.Connection) -> None:
    existing = {row['name'] for row in connection.execute('PRAGMA table_info(audio_output_snapshots)').fetchall()}
    for column, statement in AUDIO_OUTPUT_SCHEMA_ALTERS.items():
        if column not in existing:
            connection.execute(statement)
    connection.commit()


def insert_activity(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO activity_snapshots (
            captured_at, username, host, window_id, window_title, app_name,
            window_pid, window_class, idle_seconds, screenshot_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'],
            row['username'],
            row['host'],
            row.get('window_id'),
            row.get('window_title'),
            row.get('app_name'),
            row.get('window_pid'),
            row.get('window_class'),
            row.get('idle_seconds', 0),
            row.get('screenshot_path'),
        ),
    )
    connection.commit()


def insert_screenshot_event(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO screenshot_events (
            captured_at, username, host, window_id, window_title, app_name,
            status, backend, reason, attempts_json, screenshot_path, uploaded, mime_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'],
            row['username'],
            row['host'],
            row.get('window_id'),
            row.get('window_title'),
            row.get('app_name'),
            row['status'],
            row.get('backend'),
            row.get('reason'),
            json.dumps(row.get('attempts') or [], ensure_ascii=False),
            row.get('screenshot_path'),
            1 if row.get('uploaded') else 0,
            row.get('mime_type'),
        ),
    )
    connection.commit()


def insert_window_snapshot(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO window_snapshots (
            captured_at, username, host, window_id, window_title, app_name,
            window_pid, window_class, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'],
            row['username'],
            row['host'],
            row['window_id'],
            row.get('window_title'),
            row.get('app_name'),
            row.get('window_pid'),
            row.get('window_class'),
            1 if row.get('is_active') else 0,
        ),
    )
    connection.commit()


def insert_warp_activity_snapshot(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO warp_activity_snapshots (
            captured_at, username, host, warp_pid, shell_pid, observed_pid,
            observed_process_name, observed_command_line, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'],
            row['username'],
            row['host'],
            row['warp_pid'],
            row.get('shell_pid'),
            row.get('observed_pid'),
            row.get('observed_process_name'),
            row.get('observed_command_line'),
            row.get('note'),
        ),
    )
    connection.commit()


def insert_current_app_snapshot(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO current_app_snapshots (
            captured_at, username, host, app_key, app_name, pid, process_name,
            window_count, subwindow_count, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'],
            row['username'],
            row['host'],
            row['app_key'],
            row['app_name'],
            row.get('pid'),
            row.get('process_name'),
            row.get('window_count', 0),
            row.get('subwindow_count', 0),
            row.get('source'),
        ),
    )
    connection.commit()


def insert_current_subwindow_snapshot(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO current_subwindow_snapshots (
            captured_at, username, host, app_key, app_name, subwindow_type,
            title, url, window_id, pid, is_active, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'],
            row['username'],
            row['host'],
            row['app_key'],
            row['app_name'],
            row['subwindow_type'],
            row.get('title'),
            row.get('url'),
            row.get('window_id'),
            row.get('pid'),
            1 if row.get('is_active') else 0,
            row.get('source'),
        ),
    )
    connection.commit()


def insert_file_event(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO file_activity_events (
            captured_at, username, host, workspace_root, absolute_path,
            relative_path, event_type, previous_size, previous_line_count,
            previous_sha256, file_size, line_count, sha256, language, note,
            content_status, content_encoding, content_text, content_truncated,
            content_redacted, content_bytes_read, content_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'],
            row['username'],
            row['host'],
            row['workspace_root'],
            row['absolute_path'],
            row['relative_path'],
            row['event_type'],
            row.get('previous_size'),
            row.get('previous_line_count'),
            row.get('previous_sha256'),
            row.get('file_size'),
            row.get('line_count'),
            row.get('sha256'),
            row.get('language'),
            row.get('note'),
            row.get('content_status'),
            row.get('content_encoding'),
            row.get('content_text'),
            1 if row.get('content_truncated') else 0,
            1 if row.get('content_redacted') else 0,
            row.get('content_bytes_read'),
            row.get('content_reason'),
        ),
    )
    connection.commit()


def insert_process_snapshot(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO process_snapshots (
            captured_at, username, host, pid, ppid, process_name, exe_path, cwd,
            command_line, state, uid, process_username, start_time_ticks
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'],
            row['username'],
            row['host'],
            row['pid'],
            row.get('ppid'),
            row.get('process_name'),
            row.get('exe_path'),
            row.get('cwd'),
            row.get('command_line'),
            row.get('state'),
            row.get('uid'),
            row.get('process_username'),
            row.get('start_time_ticks'),
        ),
    )
    connection.commit()


def insert_process_lifecycle_event(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO process_lifecycle_events (
            captured_at, username, host, event_type, pid, ppid, process_name,
            exe_path, cwd, command_line, state, uid, process_username,
            start_time_ticks, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'],
            row['username'],
            row['host'],
            row['event_type'],
            row['pid'],
            row.get('ppid'),
            row.get('process_name'),
            row.get('exe_path'),
            row.get('cwd'),
            row.get('command_line'),
            row.get('state'),
            row.get('uid'),
            row.get('process_username'),
            row.get('start_time_ticks'),
            row.get('note'),
        ),
    )
    connection.commit()


def insert_input_click_event(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO input_click_events (
            captured_at, username, host, button, x, y, screen_x, screen_y,
            window_id, window_title, app_name, window_pid, window_class,
            target_hint, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'], row['username'], row['host'], row.get('button'),
            row.get('x'), row.get('y'), row.get('screen_x'), row.get('screen_y'),
            row.get('window_id'), row.get('window_title'), row.get('app_name'),
            row.get('window_pid'), row.get('window_class'), row.get('target_hint'),
            row.get('source'),
        ),
    )
    connection.commit()


def insert_window_focus_event(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO window_focus_events (
            captured_at, username, host, from_window_id, from_window_title,
            from_app_name, to_window_id, to_window_title, to_app_name,
            to_window_pid, to_window_class, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'], row['username'], row['host'], row.get('from_window_id'),
            row.get('from_window_title'), row.get('from_app_name'), row.get('to_window_id'),
            row.get('to_window_title'), row.get('to_app_name'), row.get('to_window_pid'),
            row.get('to_window_class'), row.get('reason'),
        ),
    )
    connection.commit()


def insert_keystroke_event(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO keystroke_events (
            captured_at, username, host, app_name, window_title, window_id,
            typed_text, key_count, source, note, keys_json, duration_seconds,
            reason, shortcut
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'], row['username'], row['host'], row.get('app_name'),
            row.get('window_title'), row.get('window_id'), row.get('typed_text'),
            row.get('key_count'), row.get('source'), row.get('note'),
            row.get('keys_json'), row.get('duration_seconds'), row.get('reason'),
            row.get('shortcut'),
        ),
    )
    connection.commit()


def insert_clipboard_event(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO clipboard_events (
            captured_at, username, host, app_name, window_title, window_id,
            content_text, content_hash, content_length, content_redacted,
            content_truncated, source, status, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'], row['username'], row['host'], row.get('app_name'),
            row.get('window_title'), row.get('window_id'), row.get('content'),
            row.get('content_hash'), row.get('content_length'),
            int(bool(row.get('content_redacted'))), int(bool(row.get('content_truncated'))),
            row.get('source'), row.get('status'), row.get('reason'),
        ),
    )
    connection.commit()


def insert_audio_output_snapshot(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO audio_output_snapshots (
            captured_at, username, host, sink_input_id, application_name,
            process_id, process_binary, media_name, node_name, corked, mute,
            volume, state_hint, mpris_player, mpris_title, mpris_artist,
            mpris_album, mpris_status, content_title, content_url, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'], row['username'], row['host'], row.get('sink_input_id'),
            row.get('application_name'), row.get('process_id'), row.get('process_binary'),
            row.get('media_name'), row.get('node_name'), row.get('corked'), row.get('mute'),
            row.get('volume'), row.get('state_hint'), row.get('mpris_player'),
            row.get('mpris_title'), row.get('mpris_artist'), row.get('mpris_album'),
            row.get('mpris_status'), row.get('content_title'), row.get('content_url'),
            row.get('source'),
        ),
    )
    connection.commit()


def upsert_file_state(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO file_state (
            workspace_root, absolute_path, relative_path, file_size, mtime_ns,
            line_count, sha256, language, last_seen_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(workspace_root, relative_path) DO UPDATE SET
            absolute_path = excluded.absolute_path,
            file_size = excluded.file_size,
            mtime_ns = excluded.mtime_ns,
            line_count = excluded.line_count,
            sha256 = excluded.sha256,
            language = excluded.language,
            last_seen_at = excluded.last_seen_at,
            deleted_at = NULL
        """,
        (
            row['workspace_root'],
            row['absolute_path'],
            row['relative_path'],
            row.get('file_size'),
            row.get('mtime_ns'),
            row.get('line_count'),
            row.get('sha256'),
            row.get('language'),
            row['last_seen_at'],
        ),
    )
    connection.commit()


def mark_file_deleted(
    connection: sqlite3.Connection,
    workspace_root: str,
    relative_path: str,
    deleted_at: str,
) -> None:
    connection.execute(
        """
        UPDATE file_state
        SET deleted_at = ?
        WHERE workspace_root = ? AND relative_path = ?
        """,
        (deleted_at, workspace_root, relative_path),
    )
    connection.commit()


def fetch_file_state_rows(db_path: Path) -> list[sqlite3.Row]:
    query = """
        SELECT
            workspace_root, absolute_path, relative_path, file_size, mtime_ns,
            line_count, sha256, language, last_seen_at, deleted_at
        FROM file_state
        ORDER BY workspace_root ASC, relative_path ASC
    """

    with connect(db_path) as connection:
        cursor = connection.execute(query)
        return list(cursor.fetchall())


def fetch_activity_rows(db_path: Path, username: str | None = None) -> list[sqlite3.Row]:
    query = """
        SELECT
            captured_at, username, host, window_id, window_title, app_name,
            window_pid, window_class, idle_seconds, screenshot_path
        FROM activity_snapshots
    """
    params: list[Any] = []
    if username:
        query += ' WHERE username = ?'
        params.append(username)
    query += ' ORDER BY captured_at ASC, id ASC'

    with connect(db_path) as connection:
        cursor = connection.execute(query, params)
        return list(cursor.fetchall())


def fetch_window_snapshot_rows(db_path: Path, username: str | None = None) -> list[sqlite3.Row]:
    query = """
        SELECT
            captured_at, username, host, window_id, window_title, app_name,
            window_pid, window_class, is_active
        FROM window_snapshots
    """
    params: list[Any] = []
    if username:
        query += ' WHERE username = ?'
        params.append(username)
    query += ' ORDER BY captured_at ASC, id ASC'

    with connect(db_path) as connection:
        cursor = connection.execute(query, params)
        return list(cursor.fetchall())


def fetch_keystroke_event_rows(db_path: Path, username: str | None = None) -> list[sqlite3.Row]:
    query = """
        SELECT
            captured_at, username, host, app_name, window_title, window_id,
            typed_text, key_count, source, note, keys_json, duration_seconds,
            reason, shortcut
        FROM keystroke_events
    """
    params: list[Any] = []
    if username:
        query += ' WHERE username = ?'
        params.append(username)
    query += ' ORDER BY captured_at ASC, id ASC'

    with connect(db_path) as connection:
        cursor = connection.execute(query, params)
        return list(cursor.fetchall())


def fetch_warp_activity_rows(db_path: Path, username: str | None = None) -> list[sqlite3.Row]:
    query = """
        SELECT
            captured_at, username, host, warp_pid, shell_pid, observed_pid,
            observed_process_name, observed_command_line, note
        FROM warp_activity_snapshots
    """
    params: list[Any] = []
    if username:
        query += ' WHERE username = ?'
        params.append(username)
    query += ' ORDER BY captured_at ASC, id ASC'

    with connect(db_path) as connection:
        cursor = connection.execute(query, params)
        return list(cursor.fetchall())


def fetch_file_event_rows(db_path: Path, username: str | None = None) -> list[sqlite3.Row]:
    query = """
        SELECT
            captured_at, username, host, workspace_root, absolute_path,
            relative_path, event_type, previous_size, previous_line_count,
            previous_sha256, file_size, line_count, sha256, language, note,
            content_status, content_encoding, content_text, content_truncated,
            content_redacted, content_bytes_read, content_reason
        FROM file_activity_events
    """
    params: list[Any] = []
    if username:
        query += ' WHERE username = ?'
        params.append(username)
    query += ' ORDER BY captured_at ASC, id ASC'

    with connect(db_path) as connection:
        cursor = connection.execute(query, params)
        return list(cursor.fetchall())


def fetch_process_snapshot_rows(db_path: Path, username: str | None = None) -> list[sqlite3.Row]:
    query = """
        SELECT
            captured_at, username, host, pid, ppid, process_name, exe_path, cwd,
            command_line, state, uid, process_username, start_time_ticks
        FROM process_snapshots
    """
    params: list[Any] = []
    if username:
        query += ' WHERE username = ?'
        params.append(username)
    query += ' ORDER BY captured_at ASC, id ASC'

    with connect(db_path) as connection:
        cursor = connection.execute(query, params)
        return list(cursor.fetchall())


def fetch_process_lifecycle_rows(db_path: Path, username: str | None = None) -> list[sqlite3.Row]:
    query = """
        SELECT
            captured_at, username, host, event_type, pid, ppid, process_name,
            exe_path, cwd, command_line, state, uid, process_username,
            start_time_ticks, note
        FROM process_lifecycle_events
    """
    params: list[Any] = []
    if username:
        query += ' WHERE username = ?'
        params.append(username)
    query += ' ORDER BY captured_at ASC, id ASC'

    with connect(db_path) as connection:
        cursor = connection.execute(query, params)
        return list(cursor.fetchall())


def insert_peripheral_snapshot(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO peripheral_snapshots (
            captured_at, username, host, device_type, device_id, name, vendor,
            model, state, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'], row['username'], row['host'], row['device_type'],
            row.get('device_id'), row.get('name'), row.get('vendor'),
            row.get('model'), row.get('state'), row.get('source'),
        ),
    )
    connection.commit()


def insert_browser_compliance_event(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO browser_compliance_events (
            captured_at, username, host, browser_key, browser_name, pid,
            process_name, command_line, status, severity, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'], row['username'], row['host'], row['browser_key'],
            row['browser_name'], row.get('pid'), row.get('process_name'),
            row.get('command_line'), row['status'], row['severity'], row.get('note'),
        ),
    )
    connection.commit()


def insert_typing_activity_event(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO keystroke_events (
            captured_at, username, host, app_name, window_title, window_id,
            typed_text, key_count, source, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row['captured_at'], row['username'], row['host'], row.get('app_name'),
            row.get('window_title'), row.get('window_id'), row.get('typed_text'),
            row.get('key_count'), row.get('source'), row.get('note'),
        ),
    )
    connection.commit()
