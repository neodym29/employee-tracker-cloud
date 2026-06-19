import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const collector = readFileSync(new URL('../agent/src/employee_tracker/collector.py', import.meta.url), 'utf8');
const installer = readFileSync(new URL('../app/api/installer/route.ts', import.meta.url), 'utf8');
const ingest = readFileSync(new URL('../app/api/ingest/route.ts', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../app/dashboard/DashboardClient.tsx', import.meta.url), 'utf8');
const screenshots = readFileSync(new URL('../agent/src/employee_tracker/screenshots.py', import.meta.url), 'utf8');

for (const expected of [
  "'rich_logs'",
  "'rich_events'",
  "'input_click'",
  "'activity_session'",
  "'typing_activity'",
  "'browser_tab'",
  "'audio_output'",
  "'file_change'",
  "'app_open'",
]) {
  assert.match(collector, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `collector should upload ${expected}`);
}

for (const expected of ['neodym-typing', '/browser-typing', 'isSensitiveInput', 'typing_activity', 'typed_sample_redacted', 'el.isContentEditable']) {
  assert.match(installer, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `installer browser extension should support safe typing telemetry: ${expected}`);
}
for (const expected of ['chrome.scripting.executeScript', 'injectContentScriptIntoOpenTabs', '__neodymTrackerBridgeContentInjected']) {
  assert.match(installer, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `browser extension reload should inject typing listeners into already-open tabs: ${expected}`);
}

for (const expected of ['richEventRows', 'body.rich_events', 'event.event_type', 'JSON.stringify(event.payload)', 'rich_events:']) {
  assert.match(ingest, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `ingest should explode rich event uploads: ${expected}`);
}

for (const expected of ['Activity logs', 'Currently open tabs', 'All event types', 'Browser search and normal text fields log exact typed text']) {
  assert.match(dashboard, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `dashboard should show ${expected}`);
}
for (const expected of ['input_click', 'activity_session', 'audio_output', 'app_open', 'file_change', 'content_status', 'content:']) {
  assert.match(dashboard, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `dashboard activity log filter/table should support ${expected}`);
}
assert.match(dashboard, /currentOpenTabs/, 'dashboard should support browser_tab rows in the current open tabs section');

for (const expected of ['_capture_windows', 'System.Windows.Forms', 'SystemInformation]::VirtualScreen', 'image/jpeg', 'CopyFromScreen']) {
  assert.match(screenshots, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `screenshot capture should support Windows silently: ${expected}`);
}

for (const expected of ['Install-BrowserExtension', 'ExtensionInstallForcelist', 'neodym-typing', 'browser-extension']) {
  assert.match(installer, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `Windows installer should install browser typing extension: ${expected}`);
}
