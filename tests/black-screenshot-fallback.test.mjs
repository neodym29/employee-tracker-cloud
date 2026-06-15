import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const screenshots = readFileSync(new URL('../agent/src/employee_tracker/screenshots.py', import.meta.url), 'utf8');
const pyproject = readFileSync(new URL('../agent/pyproject.toml', import.meta.url), 'utf8');

for (const expected of [
  'def _is_probably_black',
  'def _validated_screenshot',
  '_capture_pyautogui',
  'if _is_probably_black(path):',
]) {
  assert.match(screenshots, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `screenshot capture should reject black frames and fall back: ${expected}`);
}

assert.match(pyproject, /Pillow/, 'agent should include Pillow so screenshots can be validated');
assert.match(pyproject, /pyautogui/, 'agent should include pyautogui screenshot fallback from uploaded requirements');
