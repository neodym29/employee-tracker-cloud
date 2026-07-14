from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
import unittest

from employee_tracker.collector import ActivityCollector
from employee_tracker.config import load_settings
from employee_tracker.db import connect, init_db, insert_activity


class ResourceBatchingTests(unittest.TestCase):
    def _collector(self, base: Path, roots: tuple[Path, ...], **kwargs) -> ActivityCollector:
        db_path = base / 'activity.sqlite3'
        init_db(db_path)
        return ActivityCollector(
            db_path=db_path,
            screenshot_dir=base / 'screenshots',
            workspace_dir=roots[0],
            file_roots=roots,
            username='jerry',
            enable_screenshots=False,
            enable_keyboard_chunks=False,
            enable_clipboard=False,
            enable_process_cwd_roots=True,
            **kwargs,
        )

    def test_dynamic_file_roots_never_expand_to_home_directory(self) -> None:
        with TemporaryDirectory(dir=Path.home()) as tmp:
            base = Path(tmp)
            project = base / 'project'
            project.mkdir()
            collector = self._collector(base, (project,))
            processes = [
                SimpleNamespace(process_name='bash', cwd=str(Path.home())),
                SimpleNamespace(process_name='python', cwd=str(project)),
            ]

            roots = collector._dynamic_file_roots(processes)

        self.assertNotIn(Path.home().resolve(), roots)

    def test_file_root_batches_rotate_without_scanning_all_roots_together(self) -> None:
        with TemporaryDirectory(dir=Path.home()) as tmp:
            base = Path(tmp)
            roots = tuple(base / name for name in ('Downloads', 'Documents', 'Desktop'))
            for root in roots:
                root.mkdir()
            collector = self._collector(base, roots, max_file_roots_per_scan=1)

            batches = [collector._next_file_root_batch([]) for _ in range(4)]

        self.assertEqual(batches[0], (roots[0].resolve(),))
        self.assertEqual(batches[1], (roots[1].resolve(),))
        self.assertEqual(batches[2], (roots[2].resolve(),))
        self.assertEqual(batches[3], (roots[0].resolve(),))

    def test_successful_upload_cleanup_is_rate_limited(self) -> None:
        with TemporaryDirectory(dir=Path.home()) as tmp:
            base = Path(tmp)
            root = base / 'Desktop'
            root.mkdir()
            collector = self._collector(base, (root,), local_cleanup_interval_seconds=300)
            with connect(collector.db_path) as connection:
                with patch('employee_tracker.collector.time.monotonic', side_effect=[1000.0, 1001.0]):
                    first = collector._cleanup_local_cache(connection, '2026-07-14T00:00:00+00:00', True, None)
                    insert_activity(connection, {
                        'captured_at': '2026-07-14T00:00:01+00:00',
                        'username': 'jerry',
                        'host': 'test-host',
                    })
                    second = collector._cleanup_local_cache(connection, '2026-07-14T00:00:01+00:00', True, None)
                remaining = connection.execute('SELECT COUNT(*) FROM activity_snapshots').fetchone()[0]

        self.assertIn('deleted_rows', first)
        self.assertEqual(second.get('skipped'), 'cleanup_interval_not_elapsed')
        self.assertEqual(remaining, 1)

    def test_default_settings_use_small_batches_and_delayed_cleanup(self) -> None:
        with TemporaryDirectory() as tmp:
            with patch.dict('os.environ', {'HOME': tmp}, clear=True):
                settings = load_settings()

        self.assertEqual(settings.max_file_roots_per_scan, 1)
        self.assertGreaterEqual(settings.local_cleanup_interval_seconds, 300)
        self.assertGreaterEqual(settings.poll_interval_seconds, 3)


if __name__ == '__main__':
    unittest.main()
