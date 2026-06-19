from pathlib import Path
from types import SimpleNamespace
from tempfile import TemporaryDirectory
import sqlite3
import unittest
from unittest.mock import patch

from employee_tracker.clipboard import ClipboardWatcher, redact_clipboard_text
from employee_tracker.collector import ActivityCollector
from employee_tracker.db import connect, init_db


class ClipboardTelemetryTests(unittest.TestCase):
    def test_clipboard_redacts_secrets_and_long_tokens(self) -> None:
        text, redacted = redact_clipboard_text('ssh root@example.com\nAPI_TOKEN=abc123456789012345678901234567890xyz')
        self.assertTrue(redacted)
        self.assertIn('ssh root@example.com', text)
        self.assertIn('API_TOKEN=[REDACTED]', text)
        self.assertNotIn('abc123456789012345678901234567890xyz', text)

    def test_clipboard_watcher_captures_once_and_dedupes(self) -> None:
        values = ['ssh ubuntu@server.example.com', 'ssh ubuntu@server.example.com']
        watcher = ClipboardWatcher(max_text_chars=4096, command_runner=lambda _cmd: values.pop(0))
        first = watcher.poll()
        second = watcher.poll()
        self.assertEqual(first.status, 'captured')
        self.assertEqual(first.content, 'ssh ubuntu@server.example.com')
        self.assertEqual(second.status, 'unchanged')

    def test_collector_persists_and_uploads_clipboard_change(self) -> None:
        with TemporaryDirectory() as tmp:
            base = Path(tmp)
            db_path = base / 'activity.sqlite3'
            init_db(db_path)
            collector = ActivityCollector(
                db_path=db_path,
                screenshot_dir=base / 'screenshots',
                workspace_dir=base / 'workspace',
                file_roots=(base / 'workspace',),
                username='jerry',
                enable_screenshots=False,
                enable_keyboard_chunks=False,
                enable_file_content=False,
                enable_process_cwd_roots=False,
                enable_clipboard=True,
                file_scan_interval_seconds=999999999,
                process_scan_interval_seconds=999999999,
            )
            collector._clipboard_watcher = ClipboardWatcher(command_runner=lambda _cmd: 'scp app.py root@server:/tmp/app.py')
            collector._cloud_uploader.upload_activity = lambda payload: True
            with patch('employee_tracker.collector.current_window_info', return_value=SimpleNamespace(window_id='w1', title='Terminal', app_name='Terminal', pid=123, wm_class='terminal')):
                with patch('employee_tracker.collector.list_open_windows', return_value=[]):
                    with patch('employee_tracker.collector.summarize_current_open_state', return_value=([], [])):
                        with connect(db_path) as connection:
                            payload = collector.run_once(connection, 'host')
            clipboard_events = [event for event in payload['rich_events'] if event.get('event_type') == 'clipboard_change']
            self.assertEqual(len(clipboard_events), 1)
            self.assertIn('scp app.py', clipboard_events[0]['content'])
            with sqlite3.connect(db_path) as con:
                row = con.execute('select content_text, source, status from clipboard_events').fetchone()
            self.assertIsNotNone(row)
            self.assertIn('scp app.py', row[0])
            self.assertEqual(row[2], 'captured')


if __name__ == '__main__':
    unittest.main()
