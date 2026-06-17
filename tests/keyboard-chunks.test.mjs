import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const collector = readFileSync(new URL('../agent/src/employee_tracker/collector.py', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../app/api/installer/route.ts', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../app/dashboard/DashboardClient.tsx', import.meta.url), 'utf8');
const pyproject = readFileSync(new URL('../agent/pyproject.toml', import.meta.url), 'utf8');

for (const expected of [
  'KeyboardChunkRecorder',
  '_record_keystroke_events',
  "'typed_chunk'",
  "'shortcut'",
  "'keystrokes': keystroke_events[:120]",
]) {
  assert.match(collector, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `collector should upload keyboard chunk events: ${expected}`);
}

for (const expected of [
  'EMPLOYEE_TRACKER_ENABLE_KEYBOARD_CHUNKS=1',
  'python3-evdev',
  'setup_keyboard_input_permissions',
  'setfacl -m',
  '70-neodym-tracker-input.rules',
  'Keyboard chunks: enabled',
]) {
  assert.match(installer, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `installer should enable evdev keyboard chunks and input permissions: ${expected}`);
}

assert.match(pyproject, /evdev/, 'agent package should depend on evdev for Linux keyboard device capture');
assert.match(dashboard, /typed_chunk: 'Typed chunk'/, 'dashboard should label typed chunks');
assert.match(dashboard, /keyboard_status: 'Keyboard status'/, 'dashboard should label keyboard status diagnostics');
assert.match(dashboard, /event\.event_type === 'keyboard_status'/, 'dashboard should summarize keyboard permission/status diagnostics');
assert.match(dashboard, /shortcut: 'Shortcut'/, 'dashboard should label shortcuts');
assert.match(dashboard, /event\.event_type === 'typed_chunk'/, 'dashboard should summarize typed chunks');
assert.match(dashboard, /where typed/, 'typed chunk summary should explicitly include where the chunk was typed');
assert.match(dashboard, /event\.app_name.*event\.window_title/s, 'typed chunk summary should include app and window title location');
assert.match(dashboard, /event\.event_type === 'shortcut'/, 'dashboard should summarize shortcuts');
