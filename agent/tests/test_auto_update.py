import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from employee_tracker.auto_update import AutoUpdateSettings, AutoUpdater, _version_changed


class AutoUpdateTests(unittest.TestCase):
    def test_version_changed_compares_deploy_versions(self) -> None:
        self.assertFalse(_version_changed('abc123', 'abc123'))
        self.assertTrue(_version_changed('abc123', 'def456'))
        self.assertTrue(_version_changed('unknown', 'def456'))
        self.assertFalse(_version_changed('unknown', 'unknown'))

    def test_check_now_downloads_and_launches_installer_when_new_version_exists(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            settings = AutoUpdateSettings(
                enabled=True,
                check_url='https://example.test/api/agent-update?token=t',
                token='t',
                current_version='old',
                interval_seconds=60,
                app_dir=Path(tmp),
            )
            updater = AutoUpdater(settings)

            responses = [
                json.dumps({'latest_version': 'new', 'installer_url': 'https://example.test/installer.sh'}).encode(),
                b'#!/usr/bin/env bash\necho update\n',
            ]

            class FakeResponse:
                status = 200
                def __init__(self, body: bytes) -> None:
                    self.body = body
                def __enter__(self):
                    return self
                def __exit__(self, *_):
                    return False
                def read(self, *_):
                    return self.body

            def fake_urlopen(req, timeout=0):
                return FakeResponse(responses.pop(0))

            with mock.patch('employee_tracker.auto_update.request.urlopen', side_effect=fake_urlopen), \
                 mock.patch('employee_tracker.auto_update.subprocess.Popen') as popen, \
                 self.assertRaises(SystemExit):
                updater.check_now()

            popen.assert_called_once()
            launched_args = [str(part) for part in popen.call_args.args[0]]
            script_path = next(Path(part) for part in launched_args if part.endswith('.sh'))
            self.assertTrue(script_path.exists())
            self.assertIn('echo update', script_path.read_text())

    def test_no_launch_when_current_version_is_latest(self) -> None:
        settings = AutoUpdateSettings(
            enabled=True,
            check_url='https://example.test/api/agent-update?token=t',
            token='t',
            current_version='same',
            interval_seconds=60,
            app_dir=Path(tempfile.gettempdir()),
        )
        updater = AutoUpdater(settings)

        class FakeResponse:
            def __enter__(self):
                return self
            def __exit__(self, *_):
                return False
            def read(self, *_):
                return json.dumps({'latest_version': 'same', 'installer_url': 'https://example.test/installer.sh'}).encode()

        with mock.patch('employee_tracker.auto_update.request.urlopen', return_value=FakeResponse()), \
             mock.patch('employee_tracker.auto_update.subprocess.Popen') as popen:
            self.assertFalse(updater.check_now())
        popen.assert_not_called()


if __name__ == '__main__':
    unittest.main()
