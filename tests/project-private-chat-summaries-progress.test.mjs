import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const url = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFileSync(url(path), 'utf8');

test('chat history, list reads, assistant answers, and receipts are actor-private and fail closed for legacy null actors', () => {
  const service = read('lib/project-chat.ts');
  assert.match(service, /select role,body from project_chat_messages where project_id=\$1 and user_id=\$2 and role in \('user','assistant'\)/i);
  assert.match(service, /select id,role,body,user_id,created_at from project_chat_messages where project_id=\$1 and user_id=\$2 and role in \('user','assistant'\)/i);
  assert.match(service, /insert into project_chat_messages\(project_id,user_id,role,body\) values\(\$1,\$2,'assistant',\$3\)/i);
  assert.doesNotMatch(service, /user_id\s+is\s+null|coalesce\([^)]*user_id/i, 'legacy null assistant rows must not be assigned or exposed');
});

test('migration 016 and runtime schema create durable bounded safe client request summaries without backfill', () => {
  assert.ok(existsSync(url('migrations/016_project_client_request_summaries.sql')));
  const migration = read('migrations/016_project_client_request_summaries.sql');
  const runtime = read('lib/db.ts');
  for (const source of [migration, runtime]) {
    assert.match(source, /create table if not exists project_client_request_summaries/i);
    assert.match(source, /foreign key\s*\(\s*project_id\s*,\s*source_message_id\s*\)\s*references project_chat_messages\s*\(\s*project_id\s*,\s*id\s*\)/is);
    assert.match(source, /unique\s*\(source_message_id\)|source_message_id\s+bigint\s+not null\s+unique/i);
    assert.match(source, /length\(summary\) between 1 and 160[\s\S]*summary !~ '\[\[:cntrl:\]\]'/i);
    assert.match(source, /validate_project_client_request_summary_source/i);
    assert.match(source, /m\.role\s*=\s*'user'/i);
    assert.match(source, /m\.user_id\s*=\s*p\.client_id/i);
    assert.match(source, /add column if not exists source_message_id bigint/i, 'progress actions need durable authorization provenance');
  }
  assert.doesNotMatch(migration, /insert into project_client_request_summaries[\s\S]*select/i, 'raw legacy chat must never be summarized or copied heuristically');
});

test('backend contract uses a closed request-summary taxonomy and persistence is client-only and source-linked', () => {
  const service = read('lib/project-chat.ts');
  const bridge = read('scripts/project-agent-bridge.mjs');
  assert.match(service, /exactKeys\(result, \['answer', 'actions', 'requestSummary'\], \['answer', 'actions', 'requestSummary'\]\)/);
  assert.match(service, /contract_version:\s*2/);
  assert.match(service, /REQUEST_SUMMARY_MAX\s*=\s*160/);
  assert.match(service, /lockedProject\.client_id\s*===\s*session\.id[\s\S]*project_client_request_summaries\(project_id,source_message_id,summary\)/);
  assert.match(service, /explicitProjectProgressPercent\(String\(claimed\.rows\[0\]\.source_message_body\)\)/i);
  assert.match(bridge, /required:\s*\['answer', 'actions', 'requestSummary'\]/);
  assert.match(bridge, /requestSummarySchema[\s\S]*maxLength:\s*160/);
  assert.match(bridge, /requestSummarySchema[\s\S]*enum:/);
  assert.match(bridge, /Object\.keys\(value\)\.length !== 3/);
  assert.match(bridge, /one task completion never[\s\S]*whole project completion/i);
});

test('overview reads only summaries, scopes private chat and pending counts to actor, and UI never labels summaries as shared chat', () => {
  const overview = read('lib/project-overview.ts');
  const workspace = read('app/projects/[projectId]/WorkspaceClient.tsx');
  assert.match(overview, /project_client_request_summaries/);
  assert.match(overview, /all_chat\.user_id=\$2/);
  assert.match(overview, /pending_actions\.actor_user_id=\$2/);
  assert.doesNotMatch(overview, /from project_chat_messages message/i);
  assert.match(workspace, /Client priorities|Work brief/);
  assert.doesNotMatch(workspace, /Shared chat|No client requests in project chat|What the client asked/);
});

test('progress proposals require an explicit overall percentage and 100 percent confirmation requires completed status', () => {
  const service = read('lib/project-chat.ts');
  const bridge = read('scripts/project-agent-bridge.mjs');
  assert.match(service, /explicitProjectProgressPercent/);
  assert.match(service, /action\.type !== 'update_project_progress'[\s\S]*explicitPercent !== null[\s\S]*action\.args\.percent\) === explicitPercent/);
  assert.match(service, /did not propose an overall project progress change/i);
  assert.match(service, /Number\(proposed\.args\.percent\) === 100[\s\S]*lockedProject\.status[^\n]*completed[\s\S]*409/i);
  assert.match(bridge, /100% only after the client marks the project completed/i);
});
