import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const url = (path) => new URL(`../${path}`, import.meta.url);
const servicePath = 'lib/project-overview.ts';
const routePath = 'app/api/projects/[projectId]/overview/route.ts';

test('overview service and authenticated endpoint exist with project-scoped access', () => {
  assert.ok(existsSync(url(servicePath)), 'server-only overview service must exist');
  assert.ok(existsSync(url(routePath)), 'overview endpoint must exist');
  const service = readFileSync(url(servicePath), 'utf8');
  const route = readFileSync(url(routePath), 'utf8');
  assert.match(service, /import ['"]server-only['"]/);
  assert.match(service, /projectAccessSql/);
  assert.match(service, /where p\.id=\$1[\s\S]*access\.predicate|\$\{access\.predicate\}/);
  assert.match(route, /requireApiSession/);
  assert.match(route, /cache-control[^\n]*no-store/);
});

test('overview uses an explicit narrow DTO and excludes sensitive project output data', () => {
  const service = readFileSync(url(servicePath), 'utf8');
  assert.match(service, /CLIENT_REQUEST_LIMIT\s*=\s*3/);
  assert.match(service, /CLIENT_REQUEST_BODY_MAX\s*=\s*240/);
  assert.match(service, /slice\(0,\s*CLIENT_REQUEST_BODY_MAX\)/);
  assert.match(service, /Created project output/);
  assert.match(service, /Updated project output/);
  assert.doesNotMatch(service, /select\s+\*/i);
  assert.doesNotMatch(service, /\b(?:input|output|result|content|path|email|storage_key|sha256|manifest)\b\s*[:,]/i);
});

test('overview mapping is bounded, factual, and archived does not imply completion', async () => {
  assert.ok(existsSync(url(servicePath)), 'overview service must exist');
  const source = readFileSync(url(servicePath), 'utf8');
  const queries = [];
  const row = {
    id: '7', title: 'Launch', description: 'Ship the portal', status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    client_name: 'Client One', active_engineer_count: '2', confirmed_action_count: '3', pending_action_count: '1', total_chat_count: '9',
    client_requests: [{ id: '4', body: `  ${'x'.repeat(300)}  `, created_at: '2026-01-03T00:00:00Z' }],
    timeline: [{ id: 'action:3', label: 'Updated project output', created_at: '2026-01-04T00:00:00Z' }],
  };
  const pool = { async query(sql, values) { queries.push({ sql, values }); return { rows: [row] }; } };
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, require(specifier) {
    if (specifier === 'server-only') return {};
    if (specifier === './db') return { ensureSchema: async () => {}, getPool: () => pool };
    if (specifier === './projects') return { ProjectServiceError: class ProjectServiceError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }, projectAccessSql: () => ({ join: "left join project_memberships access_membership on true", predicate: '(authorized)' }) };
    throw new Error(`Unexpected import: ${specifier}`);
  } });
  const overview = await module.exports.getProjectOverview({ id: '11', account_type: 'engineer' }, '7');
  assert.equal(queries.length, 1, 'overview should use one fully authorized query');
  assert.match(queries[0].sql, /project_memberships access_membership/);
  assert.deepEqual(Array.from(queries[0].values), ['7', '11']);
  assert.equal(overview.stage.percent, 65);
  assert.equal(overview.clientRequests.length, 1);
  assert.equal(overview.clientRequests[0].body.length, 240);
  assert.deepEqual(Object.keys(overview.analytics).sort(), ['activeEngineerCount', 'confirmedActionCount', 'pendingActionCount', 'totalChatCount']);
  assert.equal(module.exports.projectStage('archived').percent, 0);
  assert.equal(module.exports.projectStage('completed').percent, 100);
});

test('overview normalizes nullable project copy without rendering database nulls', () => {
  const source = readFileSync(url(servicePath), 'utf8');
  assert.match(source, /String\(row\.description\s*\?\?\s*''\)/);
  assert.match(source, /String\(row\.client_name\s*\?\?\s*''\)/);
});

test('workspace renders overview first and a sticky right chat without filesystem UI', () => {
  const workspace = readFileSync(url('app/projects/[projectId]/WorkspaceClient.tsx'), 'utf8');
  const css = readFileSync(url('app/globals.css'), 'utf8');
  assert.match(workspace, /\/overview/);
  assert.match(workspace, /Project progress/);
  assert.match(workspace, /Action completion/);
  assert.match(workspace, /What the client asked/);
  assert.match(workspace, /Recent activity/);
  assert.match(workspace, /overviewPanel[\s\S]*chatRail/);
  assert.match(workspace, /<div className="workspaceGrid agentGrid">/);
  assert.doesNotMatch(workspace, /<main className="workspaceGrid agentGrid">/);
  assert.match(workspace, /Retry/);
  assert.doesNotMatch(workspace, /\/files|ProjectFile|fileRail|fileList|FileReceipt|Open or download|Agent documents/);
  assert.match(workspace, /Project member/);
  assert.doesNotMatch(workspace, /message\.role === 'assistant' \? 'Project agent' : 'You'/);
  assert.match(css, /\.agentGrid\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)\s+minmax\(360px,410px\)/s);
  assert.match(css, /\.chatRail\s*\{[^}]*position:\s*sticky[^}]*max-height:\s*calc\(100dvh\s*-\s*180px\)/s);
  assert.match(css, /\.actionList\s*\{[^}]*flex:\s*0\s+0\s+auto[^}]*max-height:\s*320px[^}]*overflow-y:\s*auto/s, 'two pending confirmations must remain fully visible instead of shrinking or hiding controls behind the composer');
  assert.match(css, /@media\s*\(max-width:\s*900px\)[\s\S]*\.agentGrid\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)/);
  assert.doesNotMatch(css, /\.fileRail\s*\{\s*order:\s*-1/);
});
