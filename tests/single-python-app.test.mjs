import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const appUrl = new URL('../single_app.py', import.meta.url);
assert.ok(existsSync(appUrl), 'single_app.py should exist at the repo root');
const source = readFileSync(appUrl, 'utf8');

for (const route of [
  'GET /api/health',
  'POST /api/ingest',
  'POST /api/login',
  'POST /api/register',
  'POST /api/signup',
  'POST /api/approve',
  'POST /api/bootstrap',
  'GET /api/screenshot',
  'GET /api/installer',
  'GET /dashboard',
]) {
  assert.match(source, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `single Python app should document/route ${route}`);
}

for (const token of [
  'ensure_schema',
  'read_dashboard',
  'rich_event_rows',
  'create_session_token',
  'parse_session_token',
  'hash_password',
  'verify_password',
  'activity_events',
  'activity_screenshots',
  'typed_chunk',
  'shortcut',
  'screenshot_capture',
  'Neodym Tracker Dashboard',
  'EMPLOYEE_TRACKER_ENABLE_KEYBOARD_CHUNKS=1',
]) {
  assert.match(source, new RegExp(token), `single Python app should include ${token}`);
}

assert.doesNotMatch(source, /from flask|import flask|FastAPI|Django/i, 'single Python app should not require a Python web framework');
assert.match(source, /HTTPServer|BaseHTTPRequestHandler/, 'single Python app should use stdlib HTTP server');
assert.match(source, /DATABASE_URL|POSTGRES_URL/, 'single Python app should use the same database env vars');
