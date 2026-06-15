import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const client = readFileSync(new URL('../app/dashboard/DashboardClient.tsx', import.meta.url), 'utf8');
const page = readFileSync(new URL('../app/dashboard/page.tsx', import.meta.url), 'utf8');
const db = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8');
const system = readFileSync(new URL('../agent/src/employee_tracker/system.py', import.meta.url), 'utf8');

assert.match(page, /<DashboardClient\s+data=\{(?:data|serializableData)\}/, 'server dashboard page should hand data to DashboardClient');
assert.match(client, /Activity logs/, 'dashboard should label the feed as activity logs, not raw state snapshots');
assert.match(client, /Currently open tabs/, 'dashboard should show current browser tabs under their own header');
assert.match(client, /activityLogEvents/, 'dashboard should derive an activity-log-only event list');
assert.match(client, /currentOpenTabs/, 'dashboard should derive current open tabs separately from logs');
assert.match(client, /event\.event_type !== 'browser_tab'/, 'browser_tab state snapshots should be excluded from activity logs');
assert.doesNotMatch(client, /title="Clicks"|title="Audio output"|title="Companies"|title="Accounts"|title="Devices"/, 'dashboard should not split into separate legacy cards anymore');
assert.match(client, /filter-start-time/, 'raw events filter should have explicit start time control');
assert.match(client, /filter-end-time/, 'raw events filter should have explicit end time control');
assert.match(client, /filter-event-type/, 'raw events filter should allow event type filtering');
assert.match(client, /filter-user/, 'raw events filter should allow user filtering');
assert.match(client, /toLocaleString/, 'event times should render as local readable timestamps, not raw UTC strings');
assert.match(client, /received_at/, 'dashboard should show/upload freshness using received_at');
assert.match(client, /audioDescription/, 'audio rows should use a dedicated clearer audio description');
assert.match(client, /Playing: |Output device:/, 'audio details should describe the media/device currently playing');
assert.match(client, /content_title/, 'audio details should prefer the actual media/tab title over just the app name');
assert.match(client, /router\.refresh\(\)/, 'dashboard should auto-refresh instead of leaving freshness text stale for minutes');
assert.doesNotMatch(client, /setEndTime\(toDateTimeLocalValue\(new Date\(\)\)\)/, 'dashboard refresh should not mutate selected time filters');
assert.match(system, /playerctl|mpris/i, 'audio collector should try player/MPRIS metadata when available');
assert.match(db, /order by received_at desc, id desc|order by id desc/, 'dashboard query should return latest received events first');
