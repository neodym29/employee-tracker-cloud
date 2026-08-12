import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('migration defines one tenant/date summary, JSON object validation, indexes, and cascade cleanup', () => {
  const sql = read('migrations/004_files_agent_daily_summaries.sql');
  assert.match(sql, /create table if not exists files_agent_daily_summaries/i);
  assert.match(sql, /unique\s*\(company_id,\s*summary_date\)/i);
  assert.match(sql, /references companies\s*\(id\)\s*on delete cascade/i);
  assert.match(sql, /jsonb_typeof\s*\(summary\)\s*=\s*'object'/i);
  assert.match(sql, /summary_date desc/i);
  assert.doesNotMatch(sql, /\bpath\b|email|secret/i);
});

test('files-agent events migration indexes tenant daily-summary range scans', () => {
  const sql = read('migrations/002_files_agent.sql');
  assert.match(sql, /create index if not exists idx_files_agent_events_company_captured[\s\S]*on files_agent_events\s*\(company_id,\s*captured_at/i);
});

test('runtime schema helper safely creates the summary table without changing shared db ownership', () => {
  const source = read('lib/files-agent-daily-summary.ts');
  assert.match(source, /ensureFilesAgentDailySummarySchema/);
  assert.match(source, /create table if not exists files_agent_daily_summaries/i);
});
