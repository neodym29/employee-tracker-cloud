import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const client = readFileSync(new URL('../app/dashboard/DashboardClient.tsx', import.meta.url), 'utf8');
const page = readFileSync(new URL('../app/dashboard/page.tsx', import.meta.url), 'utf8');
const db = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8');

assert.match(client, /filter-mode/, 'dashboard should have a latest/range mode selector');
assert.match(client, /value="latest"/, 'dashboard should offer a Latest events mode');
assert.match(client, /value="range"/, 'dashboard should offer a selected time period mode');
assert.match(client, /refresh-dashboard/, 'dashboard should have a refresh button that does not reload the whole page');
assert.match(client, /router\.refresh\(\)/, 'refresh button and auto-refresh should fetch latest data without resetting client filters');
assert.match(client, /router\.replace\(nextUrl, \{ scroll: false \}\)/, 'filter changes should be mirrored into the URL so browser reload keeps them');
assert.match(page, /searchParams/, 'server dashboard should read URL filter state on reload');
assert.match(page, /initialFilters=\{filters\}/, 'server dashboard should pass URL filters into the client');
assert.match(db, /readDashboard\(filters/, 'dashboard database reader should accept filters');
assert.match(db, /captured_at >= \$/, 'dashboard query should support explicit start time ranges');
assert.match(db, /captured_at <= \$/, 'dashboard query should support explicit end time ranges');
assert.ok(db.includes('limit $${limitParam}'), 'dashboard event query should keep a bounded parameterized latest result set');
