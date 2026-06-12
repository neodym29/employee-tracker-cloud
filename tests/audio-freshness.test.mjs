import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const db = readFileSync(new URL('../agent/src/employee_tracker/db.py', import.meta.url), 'utf8');
const collector = readFileSync(new URL('../agent/src/employee_tracker/collector.py', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../app/dashboard/DashboardClient.tsx', import.meta.url), 'utf8');

for (const column of ['mpris_player', 'mpris_title', 'mpris_artist', 'mpris_album', 'mpris_status', 'content_title', 'content_url']) {
  assert.match(db, new RegExp(`${column}\\s+TEXT`), `audio_output_snapshots schema should include ${column}`);
  assert.match(db, new RegExp(`ADD COLUMN ${column} TEXT`), `existing local DBs should be migrated with ${column}`);
}

assert.match(db, /PRAGMA synchronous=NORMAL;/, 'sqlite connection should use NORMAL synchronous mode to avoid per-event FULL fsync stalls');
assert.match(db, /PRAGMA busy_timeout=30000;/, 'sqlite connection should tolerate short writer stalls');
assert.match(collector, /poll_interval_seconds: int = 1/, 'collector constructor default should be one second');
assert.match(collector, /_enrich_audio_output/, 'collector should enrich audio outputs with browser/MPRIS content titles');
assert.match(collector, /audible_tab = next\(/, 'audio enrichment should prefer browser tabs marked audible');
assert.match(dashboard, /payload\.content_title/, 'dashboard audio details should display captured content title');
assert.match(dashboard, /Playing: /, 'dashboard audio label should emphasize what is playing, not only the app');
assert.doesNotMatch(dashboard, /`Playing in \$\{app\}/, 'dashboard should not lead audio rows with Playing in Brave');
