from pathlib import Path
import os
import tempfile
import unittest

from employee_tracker.config import load_settings
from employee_tracker.screenshots import screenshot_similarity


class ScreenshotBandwidthPolicyTests(unittest.TestCase):
    def test_default_screenshot_policy_is_active_only_and_deduped(self):
        old = {key: os.environ.get(key) for key in (
            'EMPLOYEE_TRACKER_SCREENSHOT_SECONDS',
            'EMPLOYEE_TRACKER_SCREENSHOT_ACTIVE_IDLE_SECONDS',
            'EMPLOYEE_TRACKER_SCREENSHOT_SIMILARITY_THRESHOLD',
        )}
        try:
            for key in old:
                os.environ.pop(key, None)
            settings = load_settings()
            self.assertEqual(settings.screenshot_interval_seconds, 60)
            self.assertEqual(settings.screenshot_activity_idle_seconds, 300)
            self.assertEqual(settings.screenshot_similarity_threshold, 0.985)
        finally:
            for key, value in old.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_screenshot_similarity_detects_identical_frames(self):
        try:
            from PIL import Image
        except Exception:
            self.skipTest('Pillow not installed in this environment')
        with tempfile.TemporaryDirectory() as tmp:
            left = Path(tmp) / 'left.png'
            right = Path(tmp) / 'right.png'
            Image.new('RGB', (32, 32), (40, 80, 120)).save(left)
            Image.new('RGB', (32, 32), (40, 80, 120)).save(right)
            self.assertEqual(screenshot_similarity(left, right), 1.0)

    def test_screenshot_similarity_detects_different_frames(self):
        try:
            from PIL import Image
        except Exception:
            self.skipTest('Pillow not installed in this environment')
        with tempfile.TemporaryDirectory() as tmp:
            left = Path(tmp) / 'left.png'
            right = Path(tmp) / 'right.png'
            image = Image.new('RGB', (64, 64), (255, 255, 255))
            for x in range(32):
                for y in range(64):
                    image.putpixel((x, y), (0, 0, 0))
            image.save(left)
            Image.new('RGB', (64, 64), (255, 255, 255)).save(right)
            similarity = screenshot_similarity(left, right)
            if similarity is None:
                self.fail('screenshot_similarity returned None for valid images')
            self.assertLess(similarity, 0.985)


if __name__ == '__main__':
    unittest.main()
