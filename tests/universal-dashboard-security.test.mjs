import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function loadProjectDashboard(query) {
  const javascript = ts.transpileModule(read('lib/project-dashboard.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === 'server-only') return {};
      if (specifier === './db') return { getPool: () => ({ query }) };
      throw new Error(`unexpected import: ${specifier}`);
    },
    Date,
  });
  return module.exports;
}

const clientSession = { id: '7', company_id: '1', email: 'client@example.com', role: 'employee', account_type: 'client', company_domain: 'example.com' };
const engineerSession = { ...clientSession, id: '8', account_type: 'engineer' };

function fixtureQuery(calls) {
  return async (text, values) => {
    calls.push({ text, values });
    if (/count\(distinct p\.id\)/i.test(text)) return { rows: [{ projects: 2, active_projects: 1, confirmed_changes: 3 }] };
    if (/from project_agent_actions a/i.test(text)) return { rows: [{ id: '4', project_id: '2', project_title: 'Safe title', action_type: 'update_file', confirmed_at: '2026-08-20T10:00:00Z' }] };
    return { rows: [{ id: '2', title: 'Safe title', status: 'active', updated_at: '2026-08-20T09:00:00Z' }] };
  };
}

test('universal dashboard route requires an approved session and preserves the platform admin pair guard', () => {
  const page = read('app/dashboard/page.tsx');
  assert.match(page, /requireApprovedSession\(\)/);
  assert.match(page, /session\.role\s*===\s*'admin'\s*&&\s*session\.account_type\s*===\s*'admin'/);
  assert.match(page, /readFilesAgentDashboard\(session\.company_id\)/);
  assert.match(page, /readProjectDashboard\(session\)/);
  assert.doesNotMatch(page, /requireAdminSession/);
});

test('client dashboard SQL is limited to approved projects owned by the session user', async () => {
  const calls = [];
  const { readProjectDashboard } = loadProjectDashboard(fixtureQuery(calls));
  await readProjectDashboard(clientSession);
  assert.equal(calls.length, 3);
  for (const { text, values } of calls) {
    assert.match(text, /p\.approval_status\s*=\s*'approved'/i);
    assert.match(text, /p\.client_id\s*=\s*\$1/i);
    assert.doesNotMatch(text, /project_memberships/i);
    assert.deepEqual(Array.from(values), ['7']);
  }
});

test('engineer dashboard SQL requires approved projects and active membership', async () => {
  const calls = [];
  const { readProjectDashboard } = loadProjectDashboard(fixtureQuery(calls));
  await readProjectDashboard(engineerSession);
  assert.equal(calls.length, 3);
  for (const { text, values } of calls) {
    assert.match(text, /join\s+project_memberships\s+pm/i);
    assert.match(text, /pm\.user_id\s*=\s*\$1/i);
    assert.match(text, /pm\.membership_status\s*=\s*'active'/i);
    assert.match(text, /p\.approval_status\s*=\s*'approved'/i);
    assert.deepEqual(Array.from(values), ['8']);
  }
});

test('project dashboard DTO and SQL expose only narrow metadata', async () => {
  const source = read('lib/project-dashboard.ts');
  const calls = [];
  const { readProjectDashboard } = loadProjectDashboard(fixtureQuery(calls));
  const data = await readProjectDashboard(clientSession);
  assert.deepEqual(JSON.parse(JSON.stringify(data)), {
    stats: { projects: 2, activeProjects: 1, confirmedChanges: 3 },
    projects: [{ id: '2', title: 'Safe title', status: 'active', updatedAt: '2026-08-20T09:00:00.000Z' }],
    fileChanges: [{ id: '4', projectId: '2', projectTitle: 'Safe title', actionType: 'update_file', confirmedAt: '2026-08-20T10:00:00.000Z' }],
  });
  assert.match(source, /import ['"]server-only['"]/);
  for (const { text } of calls) {
    assert.doesNotMatch(text, /(?:a\.)?(?:input|output|result)|(?:m\.)?body|(?:f\.)?content|storage_key|path|screenshot|audio/i);
  }
  assert.doesNotMatch(JSON.stringify(data), /client@example|file content|local path/i);
  assert.match(source, /p\.status\s+in\s*\(\s*'open'\s*,\s*'active'\s*\)/i);
});

test('dashboard navigation and responsive role dashboard UI are universal', () => {
  const layout = read('app/layout.tsx');
  const client = read('app/dashboard/DashboardClient.tsx');
  const css = read('app/globals.css');
  assert.match(layout, /session[\s\S]*href="\/dashboard"[^>]*>Dashboard/);
  assert.match(layout, /account_type\s*!==\s*'admin'[\s\S]*href="\/projects"/);
  assert.match(layout, /account_type\s*===\s*'admin'[\s\S]*href="\/admin\/approve"/);
  assert.match(client, /<h1>Dashboard<\/h1>/);
  assert.match(client, /Recent projects/);
  assert.match(client, /Recent confirmed agent file changes/);
  assert.match(client, /mode\s*===\s*'admin'/);
  assert.match(css, /\.dashboardGrid/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)[\s\S]*\.dashboardGrid\s*\{\s*grid-template-columns:\s*1fr/);
});
