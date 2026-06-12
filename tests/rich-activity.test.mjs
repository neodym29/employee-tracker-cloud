import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const collector = readFileSync(new URL('../agent/src/employee_tracker/collector.py', import.meta.url), 'utf8');
const ingest = readFileSync(new URL('../app/api/ingest/route.ts', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../app/dashboard/DashboardClient.tsx', import.meta.url), 'utf8');

for (const expected of [
  "'rich_logs'",
  "'rich_events'",
  "'input_click'",
  "'browser_tab'",
  "'audio_output'",
  "'app_open'",
]) {
  assert.match(collector, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `collector should upload ${expected}`);
}

for (const expected of ['richEventRows', 'body.rich_events', 'event.event_type', 'JSON.stringify(event.payload)', 'rich_events:']) {
  assert.match(ingest, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `ingest should explode rich event uploads: ${expected}`);
}

for (const expected of ['Clicks', 'Web surfing / browser tabs', 'Open apps / app activity', 'Audio output', 'Raw keystroke/character capture is intentionally not enabled']) {
  assert.match(dashboard, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `dashboard should show ${expected}`);
}
