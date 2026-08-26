import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const db = fs.readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../app/admin/approve/page.tsx', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../app/admin/approve/ApprovalClient.tsx', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../migrations/009_requeue_legacy_engineer_signups.sql', import.meta.url), 'utf8');

test('legacy rejected signup repair is exact and never revives telemetry or reviewed accounts', () => {
  assert.match(migration, /account_type\s*=\s*'engineer'/i);
  assert.match(migration, /approval_status\s*=\s*'rejected'/i);
  assert.match(migration, /password_hash\s+is\s+not\s+null/i);
  assert.match(migration, /approved_at\s+is\s+null/i);
  assert.match(migration, /reviewed_at\s+is\s+null/i);
  assert.match(migration, /reviewed_by\s+is\s+null/i);
  assert.match(migration, /get diagnostics[\s\S]*row_count/i);
  assert.match(migration, /raise exception/i);
  assert.doesNotMatch(migration, /where\s+approval_status\s*=\s*'rejected'\s*;/i);
});

test('login tells a pending account to await approval and a rejected account to contact admin', () => {
  assert.match(db, /approval_status\s*===\s*'pending'[\s\S]*Account is pending approval/);
  assert.match(db, /approval_status\s*===\s*'rejected'[\s\S]*Account was rejected/);
});

test('approval page logs backend failure and offers a retry instead of silently masking it', () => {
  assert.match(page, /console\.error\(['"]\[admin-approvals\]/);
  assert.match(client, /Retry/);
  assert.match(client, /window\.location\.reload\(\)/);
});
