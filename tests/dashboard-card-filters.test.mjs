import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const clientPath = new URL('../app/dashboard/DashboardClient.tsx', import.meta.url);
assert.ok(existsSync(clientPath), 'dashboard should use a client component for interactive per-card filters');

const client = readFileSync(clientPath, 'utf8');
const page = readFileSync(new URL('../app/dashboard/page.tsx', import.meta.url), 'utf8');

assert.match(page, /<DashboardClient\s+data=\{(?:data|serializableData)\}/, 'server dashboard page should hand data to DashboardClient');
assert.match(client, /function\s+FilteredCard|const\s+FilteredCard/, 'dashboard should define a reusable filtered card component');
assert.match(client, /filter-card-user/, 'each filtered card should render a user filter control');
assert.match(client, /filter-card-time/, 'each filtered card should render a time filter control');
assert.match(client, /All users/, 'user filter should include an All users option');
assert.match(client, /Last 15 minutes/, 'time filter should include a short recent window');
assert.match(client, /Last 24 hours/, 'time filter should include a daily window');
assert.match(client, /All time/, 'time filter should include all-time option');
assert.match(client, /employee_email|email/, 'filters should be based on row employee/user identity');
assert.match(client, /captured_at|created_at|last_seen_at/, 'filters should be based on row timestamps');

const cardUses = [...client.matchAll(/<FilteredCard\b/g)].length;
assert.ok(cardUses >= 6, `expected filters on the main dashboard cards, found ${cardUses}`);
