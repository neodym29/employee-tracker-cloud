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
  "'clipboard_change'",
  "'clipboard_status'",
  "'auto_update_status'",
  "'app_open'",
]) {
  assert.match(collector, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `collector should upload ${expected}`);
}

for (const expected of ['neodym-typing', '/browser-typing', 'isSensitiveInput', 'typing_activity', 'typed_sample_redacted', 'el.isContentEditable', 'EMPLOYEE_TRACKER_ENABLE_CLIPBOARD=1', 'EMPLOYEE_TRACKER_CLIPBOARD_MAX_TEXT_CHARS=4096', 'xclip', 'xsel', 'wl-clipboard', 'XDG_RUNTIME_DIR=%t', 'DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus', 'XAUTHORITY=%h/.Xauthority']) {
  assert.match(installer, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `installer browser extension should support safe typing telemetry: ${expected}`);
}
for (const expected of ['chrome.scripting.executeScript', 'injectContentScriptIntoOpenTabs', '__neodymTrackerBridgeContentInjected']) {
  assert.match(installer, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `browser extension reload should inject typing listeners into already-open tabs: ${expected}`);
}

for (const expected of ['richEventRows', 'body.rich_events', 'event.event_type', 'JSON.stringify(event.payload)', 'rich_events:']) {
  assert.match(ingest, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `ingest should explode rich event uploads: ${expected}`);
}

for (const expected of ['Activity logs', 'Currently open tabs', 'Device freshness', 'Last upload', 'All event types', 'Browser search and normal text fields log exact typed text']) {
  assert.match(dashboard, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `dashboard should show ${expected}`);
}
for (const expected of ['input_click', 'activity_session', 'audio_output', 'app_open', 'file_change', 'clipboard_change', 'Clipboard change', 'clipboard_status', 'Clipboard status', 'auto_update_status', 'Auto-update', 'content_status', 'content:']) {
  assert.match(dashboard, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `dashboard activity log filter/table should support ${expected}`);
}
assert.match(dashboard, /deviceFreshnessRows\(data\.devices, user\)/, 'dashboard should show per-device freshness from devices.last_seen_at, independent of latest event table limits');
assert.match(dashboard, /device\.last_seen_at/, 'device freshness should render last_seen_at timestamps');
assert.match(dashboard, /latest-event table limit/, 'device freshness helper text should explain it is independent from event list limits');
assert.match(dashboard, /const allEventTypes = \[/, 'dashboard event-type filter should use a fixed all-event-types catalog');
assert.doesNotMatch(dashboard, /const eventTypes = useMemo\(\(\) => Array\.from\(new Set\(activityLogEvents\(data\.events\)/, 'dashboard event-type filter must not be derived dynamically from current logs');
for (const expected of ['activity_snapshot', 'installer_smoke_test', 'terminal_command', 'browser_tab', 'input_click', 'activity_session', 'typing_activity', 'keyboard_status', 'screenshot_capture', 'file_change', 'clipboard_change', 'clipboard_status', 'auto_update_status', 'app_open', 'browser_compliance', 'audio_output', 'process_lifecycle', 'peripheral_snapshot', 'window_focus', 'window_snapshot', 'current_app', 'current_subwindow']) {
  assert.match(dashboard, new RegExp(`\\{ value: '${expected}'`), `fixed event-type catalog should include ${expected}`);
}
assert.match(dashboard, /currentOpenTabs/, 'dashboard should support browser_tab rows in the current open tabs section');

for (const expected of ['_capture_windows', 'System.Windows.Forms', 'SystemInformation]::VirtualScreen', 'image/jpeg', 'CopyFromScreen']) {
  assert.match(screenshots, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `screenshot capture should support Windows silently: ${expected}`);
}

for (const expected of ['Install-BrowserExtension', 'ExtensionInstallForcelist', 'neodym-typing', 'browser-extension']) {
  assert.match(installer, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `Windows installer should install browser typing extension: ${expected}`);
}
