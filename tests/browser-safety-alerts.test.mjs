import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const collector = readFileSync(new URL('../agent/src/employee_tracker/collector.py', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../app/dashboard/DashboardClient.tsx', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../app/api/installer/route.ts', import.meta.url), 'utf8');
const linuxScript = installer.match(/const script = `([\s\S]*?)`;\n  const macosScript/)?.[1] || '';

for (const expected of [
  "'event_type': 'browser_compliance'",
  'browser_compliance_events',
  'extension-missing-or-incognito',
  'Browser is open but the extension bridge did not report tabs',
]) {
  assert.match(collector, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `collector should upload browser safety event: ${expected}`);
}

for (const expected of [
  "browser_compliance: 'Browser safety'",
  'browserSafetyAlerts',
  'browser-safety-alerts',
  'Browser safety alerts',
  'redAlert',
  "event.event_type === 'browser_compliance'",
  "payload.severity === 'critical'",
  'extension missing, disabled, incognito/private, unsupported, or portable',
]) {
  assert.match(dashboard, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `dashboard should render red browser safety alert: ${expected}`);
}

assert.match(linuxScript, /EMPLOYEE_TRACKER_ENABLE_KEYBOARD_CHUNKS=0/, 'downloaded Linux app should default keyboard/raw-input chunks off for silent mode');
assert.doesNotMatch(linuxScript, /EMPLOYEE_TRACKER_ENABLE_KEYBOARD_CHUNKS=1/, 'Linux installer script must not enable keyboard chunks by default');
