import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const client = readFileSync(new URL('../app/dashboard/DashboardClient.tsx', import.meta.url), 'utf8');
const page = readFileSync(new URL('../app/dashboard/page.tsx', import.meta.url), 'utf8');
const db = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8');
const system = readFileSync(new URL('../agent/src/employee_tracker/system.py', import.meta.url), 'utf8');

assert.match(page, /<DashboardClient\s+data=\{(?:data|serializableData)\}/, 'server dashboard page should hand data to DashboardClient');
assert.match(client, /Latest raw events/, 'dashboard should keep one raw events card');
assert.doesNotMatch(client, /title="Clicks"|title="Audio output"|title="Companies"|title="Accounts"|title="Devices"/, 'dashboard should not split into separate cards anymore');
assert.match(client, /filter-start-time/, 'raw events filter should have explicit start time control');
assert.match(client, /filter-end-time/, 'raw events filter should have explicit end time control');
assert.match(client, /filter-event-type/, 'raw events filter should allow event type filtering');
assert.match(client, /filter-user/, 'raw events filter should allow user filtering');
assert.match(client, /toLocaleString/, 'event times should render as local readable timestamps, not raw UTC strings');
assert.match(client, /received_at/, 'dashboard should show/upload freshness using received_at');
assert.match(client, /audioDescription/, 'audio rows should use a dedicated clearer audio description');
assert.match(client, /Playing in|Audio stream/, 'audio details should describe which app/audio stream is currently playing');
assert.match(system, /playerctl|mpris/i, 'audio collector should try player/MPRIS metadata when available');
assert.match(db, /order by received_at desc, id desc|order by id desc/, 'dashboard query should return latest received events first');
