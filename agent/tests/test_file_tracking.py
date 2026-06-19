from pathlib import Path
from tempfile import TemporaryDirectory
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from employee_tracker.collector import ActivityCollector
from employee_tracker.config import load_settings
from employee_tracker.db import connect, fetch_file_event_rows, init_db
from employee_tracker.workspace import capture_file_content, scan_workspace


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

    def test_capture_file_content_redacts_secrets_and_skips_binary(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            env_path = root / '.env'
            env_path.write_text('API_TOKEN=super-secret\nSAFE_VALUE=hello\npassword = hunter2\n', encoding='utf-8')
            binary_path = root / 'image.png'
            binary_path.write_bytes(b'\x89PNG\x00binary')

            content = capture_file_content(env_path, max_bytes=4096)
            binary = capture_file_content(binary_path, max_bytes=4096)

        self.assertEqual(content.status, 'captured')
        self.assertTrue(content.redacted)
        self.assertIn('API_TOKEN=[REDACTED]', content.content or '')
        self.assertIn('password = [REDACTED]', content.content or '')
        self.assertNotIn('super-secret', content.content or '')
        self.assertEqual(binary.status, 'omitted')
        self.assertEqual(binary.reason, 'metadata_only_type')

    def test_collector_captures_modified_file_content_in_rich_upload_payload(self) -> None:
        with TemporaryDirectory() as tmp:
            base = Path(tmp)
            workspace = base / 'project'
            workspace.mkdir(parents=True)
            target = workspace / 'app.py'
            target.write_text('print("v1")\n', encoding='utf-8')
            db_path = base / 'activity.sqlite3'
            init_db(db_path)

            collector = ActivityCollector(
                db_path=db_path,
                screenshot_dir=base / 'screenshots',
                workspace_dir=workspace,
                file_roots=(workspace,),
                username='jerry',
                enable_screenshots=False,
                enable_file_content=True,
                file_scan_interval_seconds=0,
                process_scan_interval_seconds=9999999999,
                enable_process_cwd_roots=False,
            )
            uploaded = []
            collector._cloud_uploader.upload_activity = lambda payload: uploaded.append(payload) or True

            with connect(db_path) as connection:
                collector.run_once(connection, host='test-host')
                target.write_text('print("v2")\nAPI_TOKEN=abc123\n', encoding='utf-8')
                payload = collector.run_once(connection, host='test-host')

            rows = [dict(row) for row in fetch_file_event_rows(db_path, username='jerry')]
            modified = [row for row in rows if row['event_type'] == 'modified'][0]

        file_changes = payload['rich_logs']['file_changes']
        self.assertEqual(modified['content_status'], 'captured')
        self.assertTrue(modified['content_redacted'])
        self.assertIn('print("v2")', modified['content_text'])
        self.assertNotIn('abc123', modified['content_text'])
        self.assertTrue(any(event['event_type'] == 'file_change' and event.get('content_status') == 'captured' for event in payload['rich_events']))
        self.assertEqual(file_changes[0]['content'], modified['content_text'])
        self.assertEqual(uploaded[-1]['rich_logs']['file_changes'][0]['relative_path'], 'app.py')

    def test_dynamic_process_cwd_root_is_scanned_for_agent_workspace(self) -> None:
        with TemporaryDirectory() as tmp:
            base = Path(tmp)
            home_project = Path.home() / 'tmp-hermes-test-project'
            home_project.mkdir(exist_ok=True)
            try:
                (home_project / 'agent_notes.md').write_text('working notes\n', encoding='utf-8')
                db_path = base / 'activity.sqlite3'
                init_db(db_path)
                collector = ActivityCollector(
                    db_path=db_path,
                    screenshot_dir=base / 'screenshots',
                    workspace_dir=base / 'empty-workspace',
                    file_roots=(base / 'empty-workspace',),
                    username='jerry',
                    enable_screenshots=False,
                    enable_file_content=True,
                    file_scan_interval_seconds=0,
                )
                (base / 'empty-workspace').mkdir()
                process = SimpleNamespace(process_name='python', cwd=str(home_project))
                with connect(db_path) as connection:
                    events = collector._record_workspace_snapshot(connection, '2026-06-10T12:00:00+00:00', 'test-host', [process])
                rows = [dict(row) for row in fetch_file_event_rows(db_path, username='jerry')]
            finally:
                try:
                    (home_project / 'agent_notes.md').unlink()
                    home_project.rmdir()
                except OSError:
                    pass

        # First scan of a new dynamic root is a baseline, so it is persisted but not uploaded as a change.
        self.assertEqual(events, [])
        self.assertTrue(any(row['workspace_root'] == str(home_project.resolve()) and row['relative_path'] == 'agent_notes.md' for row in rows))


if __name__ == '__main__':
    unittest.main()
