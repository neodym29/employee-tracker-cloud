import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const screenshots = readFileSync(new URL('../agent/src/employee_tracker/screenshots.py', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../app/api/installer/route.ts', import.meta.url), 'utf8');

assert.match(screenshots, /'gnome_shell_screencast', _capture_gnome_shell_screencast/, 'agent should prefer GNOME Shell Screencast for real Wayland full-desktop capture before MSS/X11 fallbacks');
assert.match(screenshots, /org\.gnome\.Shell\.Screencast/, 'GNOME Shell Screencast backend should capture compositor pixels instead of blank X11 wrapper frames');
assert.match(screenshots, /StopScreencast/, 'GNOME Shell Screencast backend should stop the short recording after extracting a frame');
assert.match(screenshots, /_capture_mss/, 'agent should prefer MSS screen-buffer capture before desktop screenshot helpers');
assert.match(screenshots, /'mss', _capture_mss/, 'MSS should remain an early Linux whole-screen fallback after GNOME compositor capture');
assert.doesNotMatch(screenshots, /\('gnome_shell_dbus_no_flash',\s*_capture_gnome_shell_dbus\)/, 'unattended capture should not use GNOME screenshot backends that can trigger shell policy/sound/flash behavior');
assert.match(screenshots, /_capture_grim/, 'agent should try silent Wayland screenshot tools first when available');
assert.match(screenshots, /_capture_maim/, 'agent should support silent X11 maim fallback');
assert.match(screenshots, /_capture_scrot/, 'agent should support silent X11 scrot fallback');
assert.doesNotMatch(screenshots, /\['gnome-screenshot'|\("gnome-screenshot"|_capture_gnome_screenshot/, 'agent must not execute gnome-screenshot because it can visibly flash/open UI');
assert.match(screenshots, /return None/, 'agent should skip screenshots instead of falling back to a visible capture UI');
assert.doesNotMatch(installer, /gnome-screenshot/, 'Linux installer must not install gnome-screenshot for unattended tracking');
for (const pkg of ['grim', 'maim', 'scrot']) {
  assert.match(installer, new RegExp(`\\b${pkg}\\b`), `Linux installer should install ${pkg} for silent screenshot capture when supported`);
}
