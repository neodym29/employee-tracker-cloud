import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const screenshots = readFileSync(new URL('../agent/src/employee_tracker/screenshots.py', import.meta.url), 'utf8');
const pyproject = readFileSync(new URL('../agent/pyproject.toml', import.meta.url), 'utf8');

for (const expected of [
  'def _is_probably_black',
  'def _validated_screenshot',
  'if _is_probably_black(path):',
]) {
  assert.match(screenshots, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `screenshot capture should reject black frames and fall back: ${expected}`);
}

assert.doesNotMatch(screenshots, /\['gnome-screenshot'|\("gnome-screenshot"|_capture_gnome_screenshot|pyautogui|ImageGrab|spectacle/, 'black-frame fallback must not invoke visible desktop screenshot UI');

assert.match(pyproject, /Pillow/, 'agent should include Pillow so screenshots can be validated');
assert.doesNotMatch(pyproject, /pyautogui/, 'agent must not depend on pyautogui because it can call visible Linux screenshot helpers');
