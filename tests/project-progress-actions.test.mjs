import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const url = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFileSync(url(path), 'utf8');

function loadDto() {
  const source = read('lib/project-chat-dto.ts');
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, require() { throw new Error('unexpected import'); } });
  return module.exports;
}

test('migration and runtime bootstrap add constrained durable progress with status backfill', () => {
  assert.ok(existsSync(url('migrations/015_project_progress.sql')));
  const migration = read('migrations/015_project_progress.sql');
  const db = read('lib/db.ts');
  for (const source of [migration, db]) {
    assert.match(source, /progress_percent[\s\S]*between 0 and 100/i);
    assert.match(source, /progress_summary[\s\S]*length\(progress_summary\)[\s\S]*240/i);
    assert.match(source, /progress_version[\s\S]*(?:>\s*0|>=\s*1)/i);
    assert.match(source, /progress_updated_at\s+timestamptz/i);
    assert.match(source, /case[\s\S]*status[\s\S]*when 'draft' then 10[\s\S]*when 'open' then 30[\s\S]*when 'active' then 65[\s\S]*when 'completed' then 100/i);
    assert.match(source, /project_agent_actions[\s\S]*display_description\s+text/i);
    assert.match(source, /display_description[\s\S]*length\(display_description\)[\s\S]*between 1 and 320[\s\S]*!~ '\[\[:cntrl:\]\]'/i);
  }
  assert.match(migration, /add column if not exists display_description text/i, 'already-applied migration 015 must be extended additively');
});

test('migration extension and runtime bootstrap keep the persisted action description immutable', () => {
  const migration = read('migrations/015_project_progress.sql');
  const db = read('lib/db.ts');
  for (const source of [migration, db]) {
    assert.match(source, /create or replace function prevent_project_agent_action_mutation\(\)/i);
    assert.match(
      source,
      /new\.display_description\s+is\s+not\s+distinct\s+from\s+old\.display_description/i,
      'pending-to-terminal transitions must preserve both legacy null and populated display snapshots',
    );
  }
});

test('overview reads stored progress and emits specific bounded safe timeline labels', () => {
  const source = read('lib/project-overview.ts');
  assert.match(source, /p\.progress_percent/);
  assert.match(source, /progress:\s*\{[\s\S]*percent:[\s\S]*summary:[\s\S]*version:[\s\S]*updatedAt:/);
  assert.doesNotMatch(source, /status === 'open'[^\n]*percent:\s*30/);
  assert.match(source, /Progress changed from[\s\S]*% to[\s\S]*%/);
  assert.match(source, /path[\s\S]*version/i);
  assert.match(source, /left\([\s\S]*240/i);
});

test('agent has exactly one additional bounded capability and progress is always pending', () => {
  const source = read('lib/project-chat.ts');
  assert.match(source, /ACTION_TYPES\s*=\s*\[[^\]]*'create_file'[^\]]*'update_file'[^\]]*'rename_file'[^\]]*'delete_file'[^\]]*'update_project_progress'[^\]]*\]/s);
  assert.match(source, /case 'update_project_progress':[\s\S]*percent[\s\S]*summary[\s\S]*expectedVersion/);
  assert.match(source, /progress_percent[\s\S]*progress_summary[\s\S]*progress_version[\s\S]*progress_updated_at/);
  assert.match(source, /action\.type === 'create_file'[\s\S]*else[\s\S]*'pending'/);
  assert.doesNotMatch(source, /child_process|execSync|spawn\(|run_sql|execute_sql/i);
});

test('confirmation reauthorizes, locks progress, checks version, updates atomically, audits from/to, and writes receipt', () => {
  const source = read('lib/project-chat.ts');
  assert.match(source, /lockProjectAccess[\s\S]*status='pending'[\s\S]*for update/);
  assert.match(source, /select[\s\S]*progress_percent[\s\S]*progress_version[\s\S]*from projects[\s\S]*for update/i);
  assert.match(source, /progress_version conflict|Progress version conflict/i);
  assert.match(source, /update projects set progress_percent[\s\S]*progress_summary[\s\S]*progress_version=progress_version\+1[\s\S]*progress_updated_at=now\(\)[\s\S]*updated_at=now\(\)/i);
  assert.match(source, /fromPercent[\s\S]*toPercent[\s\S]*fromSummary[\s\S]*toSummary[\s\S]*fromVersion[\s\S]*toVersion/);
  assert.match(source, /insert into project_chat_messages[\s\S]*Progress updated from[\s\S]*% to[\s\S]*%/i);
});

test('public pending action has deterministic safe description and file target comes from server lookup', () => {
  const { toPublicAgentAction } = loadDto();
  const value = toPublicAgentAction({ id: 9, action_type: 'update_file', status: 'pending', created_at: '2026-09-01T00:00:00Z', description: 'Update progress-reports/latest.md from version 2 to version 3', input: { content: 'SECRET', fileId: 'hidden' } });
  assert.equal(value.description, 'Update progress-reports/latest.md from version 2 to version 3');
  assert.doesNotMatch(JSON.stringify(value), /SECRET|fileId|hidden|content/);
  const source = read('lib/project-chat.ts');
  assert.match(source, /project_file_heads[\s\S]*(?:safe_description|description)/i);
  assert.match(source, /Update project progress from[^`]*% to[^`]*%:[^`]*summary/s, 'progress proposals must state before, after, and the factual summary');
  assert.match(source, /insert into project_agent_actions\([^)]*display_description/i, 'every action must persist its immutable display snapshot');
  assert.doesNotMatch(source, /\(a\.input->>'expectedVersion'\)::integer/i, 'chat listing must not cast private JSON fields');
  assert.doesNotMatch(source, /join projects p on p\.id=a\.project_id|left join project_file_heads h on h\.project_id=a\.project_id/i, 'pending descriptions must not be rebuilt from mutable state');
});

test('legacy null display snapshots use only a static generic fallback', () => {
  const { toPublicAgentAction } = loadDto();
  const value = toPublicAgentAction({ id: 10, action_type: 'update_project_progress', status: 'pending', created_at: '2026-09-01T00:00:00Z', description: null });
  assert.equal(value.description, 'Proposed project progress change');
});

test('workspace shows descriptions and refreshes both chat and overview after confirmation', () => {
  const workspace = read('app/projects/[projectId]/WorkspaceClient.tsx');
  assert.match(workspace, /description:\s*string/);
  assert.match(workspace, /action\.description/);
  assert.match(workspace, /decideAction[\s\S]*await Promise\.all\(\[loadWorkspace\(\), loadTraceMini\(\)\]\)/);
  assert.doesNotMatch(workspace, /stage based on the current project status/i);
  assert.match(workspace, /overview\.progress\.summary/);
});
