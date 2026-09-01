import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const helperPath = new URL('lib/project-agent-documents.ts', root);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

function loadHelper(query) {
  assert.ok(existsSync(helperPath), 'canonical project-agent document helper must exist');
  const source = readFileSync(helperPath, 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module, exports: module.exports, Buffer,
    require(specifier) {
      if (specifier === 'node:crypto') return crypto;
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  return module.exports;
}

const project = { id: '42', title: 'Telemetry refresh', description: 'Improve bounded reporting.', status: 'active' };
const members = [
  { user_id: '10', display_name: 'Acme Client', account_type: 'client', membership_type: 'owner' },
  { user_id: '20', display_name: 'Ada Engineer', account_type: 'engineer', membership_type: 'creator' },
];
const statistics = { activeMembers: 2, activeEngineers: 1, clients: 1, generatedDocuments: 1, records: 3, artifacts: 2, chatMessages: 0, pendingAgentActions: 0 };

test('canonical output definitions are exact markdown paths derived from safe structured project data', () => {
  const helper = loadHelper(async () => ({ rows: [] }));
  const documents = helper.buildCanonicalProjectDocuments(project, members, statistics);
  assert.deepEqual(Array.from(documents, (document) => document.path), [
    'engineers.md', 'clients.md', 'progress-reports/latest.md', 'statistics.md',
  ]);
  assert.ok(documents.every((document) => document.mediaType === 'text/markdown'));
  const all = documents.map((document) => document.content).join('\n');
  assert.match(all, /Telemetry refresh/);
  assert.match(all, /Ada Engineer/);
  assert.match(all, /Acme Client/);
  assert.match(all, /Active engineers[^\n]*1/i);
  assert.match(all, /Records[^\n]*3/i);
  assert.match(all, /Artifacts[^\n]*2/i);
  assert.doesNotMatch(all, /Chat messages|Pending agent actions/i, 'shared documents must not expose actor-private activity counts');
  assert.doesNotMatch(all, /@|email|secret/i, 'documents must not expose or solicit private fields');
  const source = read('lib/project-agent-documents.ts');
  assert.doesNotMatch(source, /count\(\*\) from project_chat_messages|count\(\*\) from project_agent_actions[^\n]*pending/i, 'shared structured data must never aggregate private chat or pending actions');
});

test('bootstrap locks each exact path and inserts only missing immutable version-one outputs', async () => {
  const helper = loadHelper();
  const calls = [];
  const db = { async query(sql, values = []) {
    calls.push({ sql, values: Array.from(values) });
    if (/pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
    if (/select file_id from project_file_heads/i.test(sql)) return { rows: values[1] === 'clients.md' ? [{ file_id: 'existing' }] : [] };
    if (/insert into project_files/i.test(sql)) return { rows: [] };
    if (/insert into project_file_heads/i.test(sql)) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const result = await helper.ensureCanonicalProjectDocuments(db, project, members, statistics, '20');
  assert.deepEqual(Array.from(result.createdPaths), ['engineers.md', 'progress-reports/latest.md', 'statistics.md']);
  assert.deepEqual(Array.from(result.existingPaths), ['clients.md']);
  assert.equal(calls.filter(({ sql }) => /insert into project_files/i.test(sql)).length, 3);
  assert.equal(calls.filter(({ sql }) => /insert into project_file_heads/i.test(sql)).length, 3);
  assert.ok(calls.filter(({ sql }) => /insert into project_files/i.test(sql)).every(({ sql, values }) => /version/i.test(sql) && values.includes('20') && values.includes(1)));
  assert.equal(calls.filter(({ sql }) => /pg_advisory_xact_lock/i.test(sql)).length, 4);
  const statisticsInsert = calls.find(({ sql, values }) => /insert into project_files/i.test(sql) && values.includes('statistics.md'));
  assert.ok(statisticsInsert, 'statistics.md must be inserted');
  assert.match(String(statisticsInsert.values[5]), /Generated documents:\s*4/i, 'statistics must describe post-bootstrap state');
});

test('formation and first legacy chat bootstrap canonical outputs without adding upload inputs', () => {
  const projects = read('lib/projects.ts');
  const chat = read('lib/project-chat.ts');
  const ui = read('app/projects/[projectId]/WorkspaceClient.tsx');
  assert.match(projects, /ensureCanonicalProjectDocuments/);
  assert.match(projects, /project_memberships[\s\S]*ensureCanonicalProjectDocuments[\s\S]*commit/i, 'formation seeds after memberships and before commit');
  assert.match(chat, /begin[\s\S]*lockProjectAccess[\s\S]*ensureCanonicalProjectDocuments[\s\S]*commit[\s\S]*buildBoundedBackendMessages/i, 'legacy bootstrap commits before provider context is built');
  assert.match(chat, /memberRoster/);
  assert.match(chat, /projectStatistics/);
  assert.match(chat, /never uploaded inputs|never uploaded/i);
  assert.match(chat, /never ask[^.]*upload/i);
  assert.doesNotMatch(ui, /inspect project files|ask the agent to create the first file|provide remaining text/i);
  assert.match(ui, /structured project data/i);
  assert.match(ui, /Project progress/);
  assert.doesNotMatch(ui, /canonical agent documents|Agent documents|\/files/i, 'workspace must not expose generated output as a filesystem');
  assert.doesNotMatch(ui, /type=["']file["']|FormData|multipart/i, 'workspace must not introduce uploads');
});
