import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const screenshots = readFileSync(new URL('../agent/src/employee_tracker/screenshots.py', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../app/api/installer/route.ts', import.meta.url), 'utf8');

assert.doesNotMatch(screenshots, /gnome-screenshot/, 'agent must not call gnome-screenshot because it can show visible GNOME/Snap screenshot UI');
assert.match(screenshots, /_capture_grim/, 'agent should try silent Wayland screenshot tools first when available');
assert.match(screenshots, /_capture_maim/, 'agent should support silent X11 maim fallback');
assert.match(screenshots, /_capture_scrot/, 'agent should support silent X11 scrot fallback');
assert.match(screenshots, /return None/, 'agent should skip screenshots instead of falling back to a visible capture UI');
assert.doesNotMatch(installer, /gnome-screenshot/, 'Linux installer must not install gnome-screenshot');
for (const pkg of ['grim', 'maim', 'scrot']) {
  assert.match(installer, new RegExp(`\\b${pkg}\\b`), `Linux installer should install ${pkg} for silent screenshot capture when supported`);
}
