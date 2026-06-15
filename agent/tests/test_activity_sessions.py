import unittest

from employee_tracker.collector import build_activity_session_events


class ActivitySessionTests(unittest.TestCase):
    def test_groups_typing_and_clicks_into_immediate_activity_session_blocks(self) -> None:
        typing_rows = [
            {
                'captured_at': '2026-06-15T10:00:00+00:00',
                'app_name': 'Brave',
                'window_title': 'Dashboard — https://example.test',
                'window_id': 'browser:brave:window:1:tab:9',
                'url': 'https://example.test',
                'typed_text': 'quarterly invoices',
                'key_count': 18,
                'text_length': 18,
                'word_count': 2,
                'field_hint': 'Search',
                'sensitive': False,
                'source': 'browser-extension',
            }
        ]
        click_rows = [
            {
                'captured_at': '2026-06-15T10:00:01+00:00',
                'app_name': 'Brave',
                'window_title': 'Dashboard — https://example.test',
                'window_id': 'browser:brave:window:1:tab:9',
                'url': 'https://example.test',
                'button': 1,
                'x': 42,
                'y': 84,
                'screen_x': 142,
                'screen_y': 184,
                'target_hint': 'click on Submit in Dashboard (https://example.test)',
                'source': 'browser-extension',
            }
        ]

        sessions = build_activity_session_events(
            captured_at='2026-06-15T10:00:02+00:00',
            typing_rows=typing_rows,
            click_rows=click_rows,
        )

        self.assertEqual(len(sessions), 1)
        session = sessions[0]
        self.assertEqual(session['event_type'], 'activity_session')
        self.assertEqual(session['app_name'], 'Brave')
        self.assertEqual(session['window_id'], 'browser:brave:window:1:tab:9')
        self.assertEqual(session['key_count'], 18)
        self.assertEqual(session['click_count'], 1)
        self.assertEqual(session['text_length'], 18)
        self.assertEqual(session['word_count'], 2)
        self.assertIn('typed 18 chars', session['summary'])
        self.assertIn('1 click', session['summary'])
        self.assertEqual(session['clicks'][0]['target_hint'], 'click on Submit in Dashboard (https://example.test)')
        self.assertEqual(session['typed_text'], 'quarterly invoices')

    def test_redacts_sensitive_session_text(self) -> None:
        sessions = build_activity_session_events(
            captured_at='2026-06-15T10:00:02+00:00',
            typing_rows=[
                {
                    'captured_at': '2026-06-15T10:00:00+00:00',
                    'app_name': 'Brave',
                    'window_title': 'Sign in',
                    'window_id': 'browser:brave:window:1:tab:10',
                    'typed_text': '[redacted browser text: 20 chars, 3 words]',
                    'key_count': 20,
                    'text_length': 20,
                    'word_count': 3,
                    'field_hint': 'Password',
                    'sensitive': True,
                    'source': 'browser-extension',
                }
            ],
            click_rows=[],
        )

        self.assertEqual(sessions[0]['typed_text'], '[REDACTED_SENSITIVE_INPUT]')
        self.assertTrue(sessions[0]['sensitive'])


if __name__ == '__main__':
    unittest.main()
