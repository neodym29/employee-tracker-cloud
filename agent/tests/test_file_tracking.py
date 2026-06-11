from pathlib import Path
from tempfile import TemporaryDirectory
import os
import unittest
from unittest.mock import patch

from employee_tracker.collector import ActivityCollector
from employee_tracker.config import load_settings
from employee_tracker.db import connect, fetch_file_event_rows, init_db
from employee_tracker.workspace import scan_workspace


class FileTrackingTests(unittest.TestCase):
    def test_settings_parse_multiple_file_roots_for_downloads_and_workspace(self) -> None:
        with TemporaryDirectory() as tmp:
            home = Path(tmp)
            downloads = home / 'Downloads'
            workspace = home / 'Desktop' / 'employee_tracker'
            with patch.dict(
                os.environ,
                {
                    'HOME': str(home),
                    'EMPLOYEE_TRACKER_WORKSPACE': str(workspace),
                    'EMPLOYEE_TRACKER_FILE_ROOTS': f'{downloads}:{workspace}',
                },
                clear=True,
            ):
                settings = load_settings()

        self.assertEqual(settings.workspace_dir, workspace)
        self.assertEqual(settings.file_roots, (downloads, workspace))

    def test_collector_records_downloads_outside_workspace_root(self) -> None:
        with TemporaryDirectory() as tmp:
            base = Path(tmp)
            downloads = base / 'Downloads'
            workspace = base / 'Desktop' / 'employee_tracker'
            downloads.mkdir(parents=True)
            workspace.mkdir(parents=True)
            db_path = base / 'activity.sqlite3'
            init_db(db_path)
            (downloads / 'client-deck.pptx').write_bytes(b'fake presentation bytes')

            collector = ActivityCollector(
                db_path=db_path,
                screenshot_dir=base / 'screenshots',
                workspace_dir=workspace,
                file_roots=(downloads, workspace),
                username='jerry',
                enable_screenshots=False,
            )
            with connect(db_path) as connection:
                collector._record_workspace_snapshot(connection, '2026-06-10T12:00:00+00:00', 'test-host')

            rows = [dict(row) for row in fetch_file_event_rows(db_path, username='jerry')]

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['workspace_root'], str(downloads.resolve()))
        self.assertEqual(rows[0]['relative_path'], 'client-deck.pptx')
        self.assertEqual(rows[0]['event_type'], 'baseline')
        self.assertEqual(rows[0]['file_size'], len(b'fake presentation bytes'))


    def test_scan_workspace_reuses_previous_hash_when_size_and_mtime_match(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / 'stable.txt'
            path.write_text('stable\n', encoding='utf-8')
            stat_result = path.stat()
            previous = {
                'stable.txt': {
                    'file_size': stat_result.st_size,
                    'mtime_ns': stat_result.st_mtime_ns,
                    'line_count': 1,
                    'sha256': 'previous-digest',
                    'language': 'text',
                }
            }

            snapshots = list(scan_workspace(root, previous_state=previous))

        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0].sha256, 'previous-digest')
        self.assertEqual(snapshots[0].line_count, 1)
        self.assertEqual(snapshots[0].language, 'text')


if __name__ == '__main__':
    unittest.main()
