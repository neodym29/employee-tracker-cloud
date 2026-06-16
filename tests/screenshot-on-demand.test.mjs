import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const db = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8');
const ingest = readFileSync(new URL('../app/api/ingest/route.ts', import.meta.url), 'utf8');
const screenshotApi = readFileSync(new URL('../app/api/screenshot/route.ts', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../app/dashboard/DashboardClient.tsx', import.meta.url), 'utf8');
const collector = readFileSync(new URL('../agent/src/employee_tracker/collector.py', import.meta.url), 'utf8');
const agentDb = readFileSync(new URL('../agent/src/employee_tracker/db.py', import.meta.url), 'utf8');

assert.match(db, /create table if not exists activity_screenshots/, 'schema should store screenshots in a separate table');
assert.match(db, /has_screenshot/, 'dashboard query should expose only a screenshot availability flag');
assert.doesNotMatch(db, /screenshot_png_base64[\s\S]*from activity_events/, 'dashboard query must not inline screenshot base64 in the event feed');

assert.match(ingest, /screenshot_png_base64/, 'ingest should accept screenshot bytes from agent uploads');
assert.match(ingest, /delete sanitizedBody\.screenshot_png_base64/, 'ingest should strip screenshot base64 from activity_events payload');
assert.match(ingest, /insert into activity_screenshots/, 'ingest should store screenshot bytes separately');
assert.match(ingest, /screenshot_capture/, 'ingest should create a visible screenshot event after rich events so Show is not buried');
assert.match(ingest, /15_000_000/, 'ingest should accept compressed multi-monitor screenshots');

assert.match(screenshotApi, /requireAdminSession/, 'screenshot API should require admin auth');
assert.match(screenshotApi, /activity_screenshots/, 'screenshot API should read from screenshot table');
assert.match(screenshotApi, /image\/png/, 'screenshot API should return png data');

assert.match(dashboard, /showScreenshot/, 'dashboard should fetch screenshots only when Show is clicked');
assert.match(dashboard, /\/api\/screenshot\?id=/, 'dashboard should call screenshot API on demand');
assert.match(dashboard, /Show/, 'dashboard should render a Show button for screenshots');

assert.match(collector, /screenshot_png_base64/, 'collector should upload screenshot bytes with activity payloads');
assert.match(collector, /screenshot_mime_type/, 'collector should include the screenshot MIME type');
assert.match(collector, /screenshot_log/, 'collector should log screenshot capture attempts even when no image is uploaded');
assert.match(collector, /screenshot_events/, 'collector should include screenshot attempt status in rich logs');
assert.match(collector, /screenshot_result\.status/, 'collector should report screenshot capture status');
assert.match(agentDb, /CREATE TABLE IF NOT EXISTS screenshot_events/, 'local agent DB should persist screenshot attempt status logs');
assert.match(agentDb, /def insert_screenshot_event/, 'collector should be able to insert local screenshot status logs');
