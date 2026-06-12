import unittest

from employee_tracker.browser_bridge import _app_key, _browser_name


class BrowserBridgeMappingTests(unittest.TestCase):
    def test_maps_common_chromium_browser_names(self) -> None:
        cases = {
            'Google Chrome': ('Google Chrome', 'chrome'),
            'Chrome': ('Google Chrome', 'chrome'),
            'Chromium': ('Chromium', 'chromium'),
            'Brave': ('Brave', 'brave'),
            'Microsoft Edge': ('Microsoft Edge', 'edge'),
            'Edg/121': ('Microsoft Edge', 'edge'),
            'Opera': ('Opera', 'opera'),
            'OPR/106': ('Opera', 'opera'),
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                name = _browser_name(raw)
                self.assertEqual((name, _app_key(name)), expected)


if __name__ == '__main__':
    unittest.main()
