import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const screenshots = readFileSync(new URL('../agent/src/employee_tracker/screenshots.py', import.meta.url), 'utf8');

assert.match(
  screenshots,
  /whole_desktop_backends = \(/,
  'screenshot capture should explicitly group whole-desktop backends for multi-monitor capture',
);
assert.match(
  screenshots,
  /'mss', _capture_mss[\s\S]*'grim', _capture_grim[\s\S]*'maim', _capture_maim[\s\S]*'scrot_silent', _capture_scrot[\s\S]*'xwd_root', _capture_xroot/,
  'multi-monitor screenshot capture should try silent whole-desktop backends',
);
assert.match(screenshots, /def _capture_xroot/, 'Xorg fallback should capture the full root desktop before any window-only fallback');
assert.match(screenshots, /xwd', '-root'/, 'xwd root fallback should target the full virtual desktop, not one window');
assert.match(screenshots, /def _has_multiple_monitors/, 'code should detect multi-monitor desktops');
assert.match(
  screenshots,
  /if _has_multiple_monitors\(\):[\s\S]*multi_monitor_full_desktop_unavailable[\s\S]*attempts\.append\('xwd_window'\)/,
  'multi-monitor sessions should skip misleading xwd_window fallback when full-desktop capture is unavailable',
);
assert.match(
  screenshots,
  /for backend, capture in whole_desktop_backends:[\s\S]*if screenshot is not None:[\s\S]*return ScreenshotCaptureResult\(screenshot, 'captured', backend/,
  'whole-desktop captures should be returned before window-only fallback',
);
assert.match(
  screenshots,
  /window-only fallback[\s\S]*xwd_window/s,
  'xwd should be documented/used as a window-only fallback, not the primary screenshot path',
);
assert.ok(
  screenshots.indexOf('for backend, capture in whole_desktop_backends:') < screenshots.indexOf("attempts.append('xwd_window')"),
  'whole-desktop backends must run before xwd_window so secondary monitors are included',
);
assert.match(
  screenshots,
  /sct\.monitors\[0\]/,
  'MSS should capture monitor 0, which represents the full virtual desktop across monitors',
);
