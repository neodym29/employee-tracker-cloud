import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('runtime discovery bootstrap preserves every additive migration 020 statement', () => {
  const migration = readFileSync(new URL('../migrations/020_tracemini_project_discovery.sql', import.meta.url), 'utf8');
  const db = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8');
  const normalize = value => value.replace(/\s+/g, '').toLowerCase();
  for (const statement of migration.split(';').filter(value => value.trim())) {
    assert.ok(normalize(db).includes(normalize(statement)), `Missing runtime migration statement: ${statement.trim().slice(0, 100)}`);
  }
});
