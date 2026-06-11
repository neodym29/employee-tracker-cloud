from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from employee_tracker.db import (
    connect,
    fetch_process_lifecycle_rows,
    fetch_process_snapshot_rows,
    fetch_warp_activity_rows,
    fetch_window_snapshot_rows,
    init_db,
    insert_process_lifecycle_event,
    insert_process_snapshot,
    insert_warp_activity_snapshot,
    insert_window_snapshot,
)


class ProcessDbTests(unittest.TestCase):
    def test_insert_and_fetch_process_rows(self) -> None:
        with TemporaryDirectory() as tmp:
            db_path = Path(tmp) / 'activity.sqlite3'
            init_db(db_path)

            with connect(db_path) as connection:
                insert_process_snapshot(
                    connection,
                    {
                        'captured_at': '2026-01-01T00:00:00+00:00',
                        'username': 'jerry',
                        'host': 'workstation-1',
                        'pid': 123,
                        'ppid': 1,
                        'process_name': 'python3',
                        'exe_path': '/usr/bin/python3',
                        'cwd': '/srv/app',
                        'command_line': 'python3 app.py',
                        'state': 'R',
                        'uid': 1000,
                        'process_username': 'jerry',
                        'start_time_ticks': 123456,
                    },
                )
                insert_process_lifecycle_event(
                    connection,
                    {
                        'captured_at': '2026-01-01T00:00:01+00:00',
                        'username': 'jerry',
                        'host': 'workstation-1',
                        'event_type': 'started',
                        'pid': 123,
                        'ppid': 1,
                        'process_name': 'python3',
                        'exe_path': '/usr/bin/python3',
                        'cwd': '/srv/app',
                        'command_line': 'python3 app.py',
                        'state': 'R',
                        'uid': 1000,
                        'process_username': 'jerry',
                        'start_time_ticks': 123456,
                        'note': 'process observed as started',
                    },
                )
                insert_window_snapshot(
                    connection,
                    {
                        'captured_at': '2026-01-01T00:00:02+00:00',
                        'username': 'jerry',
                        'host': 'workstation-1',
                        'window_id': '0xc00005',
                        'window_title': 'Warp',
                        'app_name': 'warp-terminal',
                        'window_pid': 500,
                        'window_class': 'dev.warp.Warp/dev.warp.Warp',
                        'is_active': True,
                    },
                )
                insert_warp_activity_snapshot(
                    connection,
                    {
                        'captured_at': '2026-01-01T00:00:03+00:00',
                        'username': 'jerry',
                        'host': 'workstation-1',
                        'warp_pid': 500,
                        'shell_pid': 501,
                        'observed_pid': 502,
                        'observed_process_name': 'python3',
                        'observed_command_line': 'python3 app.py',
                        'note': 'child command under shell pid 501',
                    },
                )

            snapshots = fetch_process_snapshot_rows(db_path, username='jerry')
            lifecycle = fetch_process_lifecycle_rows(db_path, username='jerry')
            windows = fetch_window_snapshot_rows(db_path, username='jerry')
            warp_rows = fetch_warp_activity_rows(db_path, username='jerry')

        self.assertEqual(len(snapshots), 1)
        self.assertEqual(len(lifecycle), 1)
        self.assertEqual(len(windows), 1)
        self.assertEqual(len(warp_rows), 1)
        self.assertEqual(snapshots[0]['process_name'], 'python3')
        self.assertEqual(lifecycle[0]['event_type'], 'started')
        self.assertEqual(windows[0]['window_title'], 'Warp')
        self.assertEqual(warp_rows[0]['observed_process_name'], 'python3')


if __name__ == '__main__':
    unittest.main()
