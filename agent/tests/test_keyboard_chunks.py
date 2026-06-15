from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from employee_tracker.db import connect, fetch_keystroke_event_rows, init_db, insert_keystroke_event
from employee_tracker.keyboard_chunks import KeyboardChunkRecorder


class KeyboardChunkTests(unittest.TestCase):
    def test_records_shift_text_backspace_enter_and_shortcuts_as_chunks(self) -> None:
        with TemporaryDirectory() as tmp:
            recorder = KeyboardChunkRecorder(data_dir=Path(tmp), debug=False)
            recorder.handle_key_down('KEY_LEFTSHIFT')
            recorder.handle_key_down('KEY_H')
            recorder.handle_key_up('KEY_LEFTSHIFT')
            recorder.handle_key_down('KEY_I')
            recorder.handle_key_down('KEY_BACKSPACE')
            recorder.handle_key_down('KEY_1')
            recorder.handle_key_down('KEY_ENTER')
            recorder.handle_key_down('KEY_LEFTCTRL')
            recorder.handle_key_down('KEY_C')
            recorder.handle_key_up('KEY_LEFTCTRL')

            events = recorder.drain_events()

        self.assertEqual(events[0]['type'], 'typed_chunk')
        self.assertEqual(events[0]['reason'], 'enter')
        self.assertEqual(events[0]['text'], 'H1\n')
        self.assertEqual(events[0]['key_count'], 5)
        self.assertIn('KEY_BACKSPACE', events[0]['keys'])
        self.assertEqual(events[1]['type'], 'shortcut')
        self.assertEqual(events[1]['shortcut'], 'KEY_C+KEY_LEFTCTRL')

    def test_persists_keyboard_chunks_in_existing_activity_database(self) -> None:
        with TemporaryDirectory() as tmp:
            db_path = Path(tmp) / 'activity.sqlite3'
            init_db(db_path)
            with connect(db_path) as connection:
                insert_keystroke_event(
                    connection,
                    {
                        'captured_at': '2026-06-15T10:00:00+00:00',
                        'username': 'jerry',
                        'host': 'workstation-1',
                        'app_name': 'Keyboard',
                        'window_title': 'typed chunk',
                        'window_id': None,
                        'typed_text': 'hello world',
                        'key_count': 11,
                        'keys_json': '["KEY_H"]',
                        'duration_seconds': 1.25,
                        'reason': 'idle',
                        'shortcut': None,
                        'source': 'evdev-keyboard-chunks',
                        'note': 'typed chunk flushed by idle',
                    },
                )
            rows = fetch_keystroke_event_rows(db_path, username='jerry')

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['typed_text'], 'hello world')
        self.assertEqual(rows[0]['keys_json'], '["KEY_H"]')
        self.assertEqual(rows[0]['duration_seconds'], 1.25)
        self.assertEqual(rows[0]['reason'], 'idle')
        self.assertEqual(rows[0]['source'], 'evdev-keyboard-chunks')


if __name__ == '__main__':
    unittest.main()
