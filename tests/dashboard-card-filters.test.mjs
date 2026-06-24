import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const clientPath = new URL('../app/dashboard/DashboardClient.tsx', import.meta.url);
assert.ok(existsSync(clientPath), 'dashboard should use a client component for interactive raw-event filters');

const client = readFileSync(clientPath, 'utf8');
const page = readFileSync(new URL('../app/dashboard/page.tsx', import.meta.url), 'utf8');

assert.match(page, /<DashboardClient\s+data=\{(?:data|serializableData)\}/, 'server dashboard page should hand data to DashboardClient');
assert.match(client, /Activity logs/, 'dashboard should render an activity logs card');
assert.match(client, /dashboardCardRegistry/, 'dashboard should define a card registry for configurable cards');
assert.match(client, /Customize cards for this user/, 'dashboard should expose per-user card customization controls');
assert.match(client, /localStorage\.setItem\(dashboardCardStorageKey\(user\)/, 'dashboard should persist visible cards per selected user');
assert.match(client, /visibleCardIds\.map/, 'dashboard should render cards from the selected card configuration');
assert.match(client, /device_freshness/, 'card registry should include the device freshness card');
assert.match(client, /current_open_tabs/, 'card registry should include the open tabs card');
assert.match(client, /activity_logs/, 'card registry should include the activity logs card');
assert.match(client, /browser_safety_alerts/, 'card registry should include the browser safety alerts card');
assert.match(client, /filter-user/, 'raw events card should render a user filter control');
assert.match(client, /filter-event-type/, 'raw events card should render an event type filter control');
assert.match(client, /filter-start-time/, 'raw events card should render a start time control');
assert.match(client, /filter-end-time/, 'raw events card should render an end time control');
assert.match(client, /All users/, 'user filter should include an All users option');
assert.match(client, /All event types/, 'event filter should include all event types option');
assert.match(client, /datetime-local/, 'time filter should use selectable date/time windows, not vague relative dropdowns');
assert.match(client, /captured_at/, 'filters should use event captured timestamps');
assert.match(client, /received_at/, 'dashboard should expose upload/received freshness');

const filteredCardUses = [...client.matchAll(/<FilteredCard\b/g)].length;
assert.equal(filteredCardUses, 0, 'dashboard should not split events into multiple per-category cards');
