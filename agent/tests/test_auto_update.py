import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from employee_tracker.auto_update import AutoUpdateSettings, AutoUpdater


class AutoUpdateFallbackTests(unittest.TestCase):
    def test_systemd_run_failure_falls_back_to_bash_and_records_status(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            app_dir = Path(tmp)
            settings = AutoUpdateSettings(
                enabled=True,
                check_url='https://example.test/update',
                token='token',
                current_version='old',
                interval_seconds=60,
                app_dir=app_dir,
            )
            updater = AutoUpdater(settings)
            installer = app_dir / 'installer.sh'
            installer.write_text('#!/usr/bin/env bash\nexit 0\n')
            with patch.object(updater, '_fetch_update_info', return_value={'latest_version': 'new', 'installer_url': 'https://example.test/installer'}):
                with patch.object(updater, '_download_installer', return_value=installer):
                    with patch('employee_tracker.auto_update.platform.system', return_value='Linux'):
                        with patch('employee_tracker.auto_update.shutil.which', return_value='/usr/bin/systemd-run'):
                            failed = Mock(returncode=1, stdout='', stderr='Failed to connect to bus')
                            with patch('employee_tracker.auto_update.subprocess.run', return_value=failed) as run_mock:
                                with patch('employee_tracker.auto_update.subprocess.Popen') as popen_mock:
                                    self.assertTrue(updater.check_now())
            run_mock.assert_called_once()
            popen_mock.assert_called_once()
            args = popen_mock.call_args.args[0]
            self.assertEqual(args[:1], ['bash'])
            events = updater.drain_events('now', 'jerry', 'host')
            statuses = [event['status'] for event in events]
            self.assertIn('available', statuses)
            launched = [event for event in events if event['status'] == 'installer_launched'][0]
            self.assertEqual(launched['method'], 'bash-fallback')
            self.assertTrue(launched['systemd_run_failed'])
            self.assertEqual(launched['username'], 'jerry')
            self.assertEqual(launched['host'], 'host')


if __name__ == '__main__':
    unittest.main()
