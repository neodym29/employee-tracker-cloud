import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const screenshots = readFileSync(new URL('../agent/src/employee_tracker/screenshots.py', import.meta.url), 'utf8');

assert.match(screenshots, /def _resolve_xwindow_id/, 'screenshot capture should resolve usable X11 window ids before calling xwd');
assert.match(screenshots, /browser-extension events use synthetic ids|synthetic ids/, 'code should document synthetic browser tab ids are invalid for xwd');
assert.match(screenshots, /xdotool', 'getactivewindow'/, 'synthetic/non-X ids should fall back to the real active X window id');
assert.match(screenshots, /_is_real_xwindow_id/, 'code should validate ids before passing them to xwd');
assert.match(screenshots, /x_window_id = _resolve_xwindow_id\(window_id\)/, 'capture path should use the resolved X window id');
assert.doesNotMatch(screenshots, /_capture_xwindow\(destination_dir, prefix, timestamp, window_id\)/, 'capture path must not pass synthetic browser ids directly to xwd');

assert.match(screenshots, /which\('convert'\)/, 'xwd conversion should support ImageMagick convert because ffmpeg may lack xwd demuxing');
assert.match(screenshots, /which\('magick'\)/, 'xwd conversion should support ImageMagick magick fallback');
assert.match(screenshots, /not converted and which\('ffmpeg'\)/, 'ffmpeg should only be a fallback after ImageMagick conversion');
