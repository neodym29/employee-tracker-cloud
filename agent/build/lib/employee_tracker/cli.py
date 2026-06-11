from __future__ import annotations

import argparse
import csv
from pathlib import Path
import sys

from .collector import ActivityCollector
from .config import load_settings
from .db import (
    fetch_activity_rows,
    fetch_file_event_rows,
    fetch_process_lifecycle_rows,
    fetch_process_snapshot_rows,
    fetch_warp_activity_rows,
    fetch_window_snapshot_rows,
    init_db,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog='employee-tracker')
    subparsers = parser.add_subparsers(dest='command', required=True)

    subparsers.add_parser('init-db', help='Create the SQLite schema')
    subparsers.add_parser('run', help='Run the background collector')

    export_parser = subparsers.add_parser('export-csv', help='Export activity logs from SQLite to CSV')
    export_parser.add_argument('--output', type=Path, required=True, help='Destination CSV file path')
    export_parser.add_argument('--username', help='Optional username filter for per-person exports')
    export_parser.add_argument(
        '--dataset',
        choices=('all', 'activity', 'files', 'processes', 'process-events', 'windows', 'warp'),
        default='all',
        help='Choose which dataset to export',
    )

    return parser


def _base_row(event_kind: str, row) -> dict[str, object | None]:
    return {
        'event_kind': event_kind,
        'captured_at': row['captured_at'],
        'username': row['username'],
        'host': row['host'],
        'workspace_root': '',
        'relative_path': '',
        'absolute_path': '',
        'event_type': '',
        'previous_size': '',
        'previous_line_count': '',
        'previous_sha256': '',
        'file_size': '',
        'line_count': '',
        'sha256': '',
        'language': '',
        'note': '',
        'window_id': '',
        'window_title': '',
        'app_name': '',
        'window_pid': '',
        'window_class': '',
        'is_active': '',
        'idle_seconds': '',
        'screenshot_path': '',
        'pid': '',
        'ppid': '',
        'process_name': '',
        'exe_path': '',
        'cwd': '',
        'command_line': '',
        'state': '',
        'uid': '',
        'process_username': '',
        'start_time_ticks': '',
        'warp_pid': '',
        'shell_pid': '',
        'observed_pid': '',
        'observed_process_name': '',
        'observed_command_line': '',
    }


def _normalize_window_row(row) -> dict[str, object | None]:
    result = _base_row('window_activity', row)
    result.update(
        {
            'window_id': row['window_id'],
            'window_title': row['window_title'],
            'app_name': row['app_name'],
            'window_pid': row['window_pid'],
            'window_class': row['window_class'],
            'idle_seconds': row['idle_seconds'],
            'screenshot_path': row['screenshot_path'],
        }
    )
    return result


def _normalize_open_window_row(row) -> dict[str, object | None]:
    result = _base_row('open_window', row)
    result.update(
        {
            'window_id': row['window_id'],
            'window_title': row['window_title'],
            'app_name': row['app_name'],
            'window_pid': row['window_pid'],
            'window_class': row['window_class'],
            'is_active': row['is_active'],
        }
    )
    return result


def _normalize_file_row(row) -> dict[str, object | None]:
    result = _base_row('file', row)
    result.update(
        {
            'workspace_root': row['workspace_root'],
            'relative_path': row['relative_path'],
            'absolute_path': row['absolute_path'],
            'event_type': row['event_type'],
            'previous_size': row['previous_size'],
            'previous_line_count': row['previous_line_count'],
            'previous_sha256': row['previous_sha256'],
            'file_size': row['file_size'],
            'line_count': row['line_count'],
            'sha256': row['sha256'],
            'language': row['language'],
            'note': row['note'],
        }
    )
    return result


def _normalize_process_snapshot_row(row) -> dict[str, object | None]:
    result = _base_row('process_snapshot', row)
    result.update(
        {
            'pid': row['pid'],
            'ppid': row['ppid'],
            'process_name': row['process_name'],
            'exe_path': row['exe_path'],
            'cwd': row['cwd'],
            'command_line': row['command_line'],
            'state': row['state'],
            'uid': row['uid'],
            'process_username': row['process_username'],
            'start_time_ticks': row['start_time_ticks'],
        }
    )
    return result


def _normalize_process_event_row(row) -> dict[str, object | None]:
    result = _base_row('process_event', row)
    result.update(
        {
            'event_type': row['event_type'],
            'note': row['note'],
            'pid': row['pid'],
            'ppid': row['ppid'],
            'process_name': row['process_name'],
            'exe_path': row['exe_path'],
            'cwd': row['cwd'],
            'command_line': row['command_line'],
            'state': row['state'],
            'uid': row['uid'],
            'process_username': row['process_username'],
            'start_time_ticks': row['start_time_ticks'],
        }
    )
    return result


def _normalize_warp_row(row) -> dict[str, object | None]:
    result = _base_row('warp_activity', row)
    result.update(
        {
            'note': row['note'],
            'warp_pid': row['warp_pid'],
            'shell_pid': row['shell_pid'],
            'observed_pid': row['observed_pid'],
            'observed_process_name': row['observed_process_name'],
            'observed_command_line': row['observed_command_line'],
        }
    )
    return result


def export_csv(db_path: Path, output: Path, dataset: str = 'all', username: str | None = None) -> int:
    if dataset == 'activity':
        rows = [_normalize_window_row(row) for row in fetch_activity_rows(db_path, username=username)]
    elif dataset == 'files':
        rows = [_normalize_file_row(row) for row in fetch_file_event_rows(db_path, username=username)]
    elif dataset == 'processes':
        rows = [_normalize_process_snapshot_row(row) for row in fetch_process_snapshot_rows(db_path, username=username)]
    elif dataset == 'process-events':
        rows = [_normalize_process_event_row(row) for row in fetch_process_lifecycle_rows(db_path, username=username)]
    elif dataset == 'windows':
        rows = [_normalize_open_window_row(row) for row in fetch_window_snapshot_rows(db_path, username=username)]
    elif dataset == 'warp':
        rows = [_normalize_warp_row(row) for row in fetch_warp_activity_rows(db_path, username=username)]
    else:
        rows = [
            *(_normalize_window_row(row) for row in fetch_activity_rows(db_path, username=username)),
            *(_normalize_open_window_row(row) for row in fetch_window_snapshot_rows(db_path, username=username)),
            *(_normalize_file_row(row) for row in fetch_file_event_rows(db_path, username=username)),
            *(_normalize_process_snapshot_row(row) for row in fetch_process_snapshot_rows(db_path, username=username)),
            *(_normalize_process_event_row(row) for row in fetch_process_lifecycle_rows(db_path, username=username)),
            *(_normalize_warp_row(row) for row in fetch_warp_activity_rows(db_path, username=username)),
        ]
        rows.sort(
            key=lambda row: (
                str(row['captured_at']),
                str(row['event_kind']),
                str(row['window_id']),
                str(row['pid']),
                str(row['warp_pid']),
                str(row['relative_path']),
            )
        )

    output.parent.mkdir(parents=True, exist_ok=True)

    fieldnames = [
        'event_kind', 'captured_at', 'username', 'host',
        'workspace_root', 'relative_path', 'absolute_path',
        'event_type', 'previous_size', 'previous_line_count', 'previous_sha256',
        'file_size', 'line_count', 'sha256', 'language', 'note',
        'window_id', 'window_title', 'app_name', 'window_pid', 'window_class', 'is_active',
        'idle_seconds', 'screenshot_path',
        'pid', 'ppid', 'process_name', 'exe_path', 'cwd', 'command_line', 'state', 'uid',
        'process_username', 'start_time_ticks',
        'warp_pid', 'shell_pid', 'observed_pid', 'observed_process_name', 'observed_command_line',
    ]

    with output.open('w', newline='', encoding='utf-8') as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, '') for field in fieldnames})

    print(f'Exported {len(rows)} rows to {output}')
    return len(rows)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = load_settings()

    if args.command == 'init-db':
        init_db(settings.db_path)
        print(f'Initialized database at {settings.db_path}')
        return 0

    if args.command == 'run':
        init_db(settings.db_path)
        collector = ActivityCollector(
            db_path=settings.db_path,
            screenshot_dir=settings.screenshot_dir,
            workspace_dir=settings.workspace_dir,
            file_roots=settings.file_roots,
            username=settings.username,
            poll_interval_seconds=settings.poll_interval_seconds,
            screenshot_interval_seconds=settings.screenshot_interval_seconds,
            file_scan_interval_seconds=settings.file_scan_interval_seconds,
            process_scan_interval_seconds=settings.process_scan_interval_seconds,
            enable_screenshots=settings.enable_screenshots,
        )
        collector.run_forever()
        return 0

    if args.command == 'export-csv':
        init_db(settings.db_path)
        export_csv(settings.db_path, args.output, dataset=args.dataset, username=args.username)
        return 0

    raise SystemExit(f'Unknown command: {args.command}')


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
