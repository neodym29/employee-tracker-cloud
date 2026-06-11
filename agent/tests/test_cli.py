from pathlib import Path
from tempfile import TemporaryDirectory
import csv
import unittest

from employee_tracker.cli import export_csv
from employee_tracker.db import (
    connect,
    init_db,
    insert_process_lifecycle_event,
    insert_process_snapshot,
    insert_warp_activity_snapshot,
    insert_window_snapshot,
)


class CliExportTests(unittest.TestCase):
    def test_export_process_window_and_warp_datasets_to_csv(self) -> None:
        with TemporaryDirectory() as tmp:
            db_path = Path(tmp) / 'activity.sqlite3'
            output_path = Path(tmp) / 'processes.csv'
            init_db(db_path)

            with connect(db_path) as connection:
                insert_process_snapshot(
                    connection,
                    {
                        'captured_at': '2026-01-01T00:00:00+00:00',
                        'username': 'jerry',
                        'host': 'workstation-1',
                        'pid': 321,
                        'ppid': 1,
                        'process_name': 'code',
                        'exe_path': '/usr/bin/code',
                        'cwd': '/workspace',
                        'command_line': 'code /workspace',
                        'state': 'S',
                        'uid': 1000,
                        'process_username': 'jerry',
                        'start_time_ticks': 888,
                    },
                )
                insert_process_lifecycle_event(
                    connection,
                    {
                        'captured_at': '2026-01-01T00:00:01+00:00',
                        'username': 'jerry',
                        'host': 'workstation-1',
                        'event_type': 'started',
                        'pid': 321,
                        'ppid': 1,
                        'process_name': 'code',
                        'exe_path': '/usr/bin/code',
                        'cwd': '/workspace',
                        'command_line': 'code /workspace',
                        'state': 'S',
                        'uid': 1000,
                        'process_username': 'jerry',
                        'start_time_ticks': 888,
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

            exported_count = export_csv(db_path, output_path, dataset='processes', username='jerry')
            with output_path.open(newline='', encoding='utf-8') as handle:
                rows = list(csv.DictReader(handle))

            self.assertEqual(exported_count, 1)
            self.assertEqual(rows[0]['event_kind'], 'process_snapshot')
            self.assertEqual(rows[0]['process_name'], 'code')

            windows_output = Path(tmp) / 'windows.csv'
            exported_windows = export_csv(db_path, windows_output, dataset='windows', username='jerry')
            with windows_output.open(newline='', encoding='utf-8') as handle:
                window_rows = list(csv.DictReader(handle))
            self.assertEqual(exported_windows, 1)
            self.assertEqual(window_rows[0]['window_title'], 'Warp')

            warp_output = Path(tmp) / 'warp.csv'
            exported_warp = export_csv(db_path, warp_output, dataset='warp', username='jerry')
            with warp_output.open(newline='', encoding='utf-8') as handle:
                warp_rows = list(csv.DictReader(handle))
            self.assertEqual(exported_warp, 1)
            self.assertEqual(warp_rows[0]['observed_process_name'], 'python3')

            output_all = Path(tmp) / 'all.csv'
            exported_all = export_csv(db_path, output_all, dataset='all', username='jerry')
            with output_all.open(newline='', encoding='utf-8') as handle:
                all_rows = list(csv.DictReader(handle))

        self.assertEqual(exported_all, 4)
        self.assertEqual(
            {row['event_kind'] for row in all_rows},
            {'process_snapshot', 'process_event', 'open_window', 'warp_activity'},
        )


if __name__ == '__main__':
    unittest.main()
