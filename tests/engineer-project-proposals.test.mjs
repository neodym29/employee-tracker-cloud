import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('lib/projects.ts', root), 'utf8');
const routeSource = readFileSync(new URL('app/api/projects/route.ts', root), 'utf8');
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const engineer = { id: '20', role: 'employee', account_type: 'engineer' };
const client = { id: '10', role: 'employee', account_type: 'client' };

function loadProjects(query) {
  const calls = [];
  const connection = {
    async query(sql, values = []) { calls.push({ sql, values }); return query(sql, values); },
    release() { calls.push({ sql: 'release', values: [] }); },
  };
  const pool = {
    async query(sql, values = []) { calls.push({ sql, values }); return query(sql, values); },
    async connect() { calls.push({ sql: 'connect', values: [] }); return connection; },
  };
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === 'node:crypto') return crypto;
      if (specifier === './db') return { ensureSchema: async () => {}, getPool: () => pool };
      throw new Error(`Unexpected import: ${specifier}`);
    },
    Buffer,
    console,
  });
  return { service: module.exports, calls };
}

function loadProjectsRoute({ session = engineer, body = {}, create = async () => ({ id: '99' }), originError } = {}) {
  const calls = [];
  const javascript = ts.transpileModule(routeSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === 'next/server') return {
        NextResponse: { json: (value, init = {}) => ({ value, status: init.status ?? 200, headers: init.headers }) },
      };
      if (specifier === '@/lib/api') return {
        assertSameOrigin(req) { calls.push(['origin', req]); if (originError) throw originError; },
        async requireApiSession(...args) { calls.push(['session', ...args]); return session; },
        async jsonBody(req) { calls.push(['body', req]); return body; },
        apiErrorResponse(error) { calls.push(['error', error]); return { value: { ok: false, error: 'safe' }, status: 500 }; },
      };
      if (specifier === '@/lib/projects') return {
        async createProject(...args) { calls.push(['create', ...args]); return create(...args); },
        async listProjects() { return []; },
      };
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  return { route: module.exports, calls };
}

function isForbidden(error) {
  assert.equal(error?.constructor?.name, 'ProjectServiceError');
  assert.equal(error?.status, 403);
  assert.equal(error?.code, 'forbidden');
  return true;
}

function isConflict(error) {
  assert.equal(error?.constructor?.name, 'ProjectServiceError');
  assert.equal(error?.status, 409);
  assert.equal(error?.code, 'conflict');
  return true;
}

function isNotFound(error) {
  assert.equal(error?.constructor?.name, 'ProjectServiceError');
  assert.equal(error?.status, 404);
  assert.equal(error?.code, 'not_found');
  return true;
}

const isProposalLookup = (sql) => /select[\s\S]+from projects p[\s\S]+project_memberships pm/i.test(sql);

test('approved-client discovery is engineer-only and returns only id/display_name', async () => {
  const rows = [{ id: '10', display_name: 'Acme' }];
  const { service, calls } = loadProjects(async (sql) => {
    assert.match(sql, /select id,display_name from app_users/i);
    assert.match(sql, /account_type='client'/i);
    assert.match(sql, /approval_status='approved'/i);
    assert.doesNotMatch(sql, /email|password|secret/i);
    return { rows };
  });

  assert.deepEqual(await service.listAvailableClients(engineer), rows);
  await assert.rejects(service.listAvailableClients(client), isForbidden);
  assert.equal(calls.filter((call) => /from app_users/i.test(call.sql)).length, 1, 'forbidden roles must fail before querying');
});

test('engineer proposal atomically creates a client-owned draft and pending request membership', async () => {
  const project = { id: '99', client_id: '10', title: 'Trace model', description: 'Build it', status: 'draft' };
  const membership = { id: '101', project_id: '99', user_id: '20', membership_type: 'request', membership_status: 'pending', created_by: '20' };
  const { service, calls } = loadProjects(async (sql, values) => {
    if (/^begin$|^commit$|^rollback$|pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
    if (isProposalLookup(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) {
      assert.match(sql, /from app_users/i);
      assert.match(sql, /account_type='client'/i);
      assert.match(sql, /approval_status='approved'/i);
      assert.deepEqual(Array.from(values), ['10', 'Trace model', 'Build it', 'draft']);
      return { rows: [project] };
    }
    if (/insert into project_memberships/i.test(sql)) {
      assert.match(sql, /'request','pending'/i);
      assert.deepEqual(Array.from(values), ['99', '20']);
      return { rows: [membership] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await service.createProject(engineer, { clientId: '10', title: ' Trace model ', description: ' Build it ', status: 'open' });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ...project, membership });
  assert.equal(calls[0].sql, 'connect');
  assert.equal(calls[1].sql, 'begin');
  assert.match(calls[2].sql, /pg_advisory_xact_lock/i);
  assert.ok(isProposalLookup(calls[3].sql));
  assert.match(calls[4].sql, /insert into projects/i);
  assert.match(calls[5].sql, /insert into project_memberships/i);
  assert.equal(calls[6].sql, 'commit');
  assert.equal(calls[7].sql, 'release');
});

test('proposal retries return the existing pending draft without a second insert', async () => {
  const project = { id: '99', client_id: '10', title: 'Trace model', description: 'Build it', status: 'draft' };
  const membership = { id: '101', project_id: '99', user_id: '20', membership_type: 'request', membership_status: 'pending', created_by: '20' };
  let stored = false;
  let inserts = 0;
  const { service, calls } = loadProjects(async (sql, values) => {
    if (/^begin$|^commit$|pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
    if (isProposalLookup(sql)) {
      assert.match(sql, /p\.client_id=\$1/i);
      assert.match(sql, /p\.status='draft'/i);
      assert.match(sql, /p\.title=\$3/i);
      assert.match(sql, /pm\.user_id=\$2/i);
      assert.match(sql, /pm\.membership_type='request'/i);
      assert.match(sql, /pm\.membership_status='pending'/i);
      assert.match(sql, /pm\.created_by=\$2/i);
      assert.deepEqual(Array.from(values), ['10', '20', 'Trace model']);
      return { rows: stored ? [{ ...project, membership_id: membership.id, membership_project_id: membership.project_id, membership_user_id: membership.user_id, membership_type: membership.membership_type, membership_status: membership.membership_status, membership_created_by: membership.created_by }] : [] };
    }
    if (/insert into projects/i.test(sql)) { inserts += 1; stored = true; return { rows: [project] }; }
    if (/insert into project_memberships/i.test(sql)) return { rows: [membership] };
    throw new Error(`Unexpected query: ${sql}`);
  });

  const first = await service.createProject(engineer, { clientId: '10', title: ' Trace model ', description: 'Build it' });
  const retry = await service.createProject(engineer, { clientId: '10', title: 'Trace model', description: 'changed on retry' });
  assert.deepEqual(JSON.parse(JSON.stringify(retry)), JSON.parse(JSON.stringify(first)));
  assert.equal(inserts, 1);

  const statements = calls.map((call) => call.sql);
  const secondBegin = statements.findIndex((sql, index) => index > 1 && /^begin$/i.test(sql));
  const secondLock = statements.findIndex((sql, index) => index > secondBegin && /pg_advisory_xact_lock/i.test(sql));
  const secondLookup = statements.findIndex((sql, index) => index > secondLock && isProposalLookup(sql));
  assert.ok(secondBegin < secondLock && secondLock < secondLookup, 'transaction lock must serialize before duplicate lookup');
});

test('distinct normalized titles remain distinct proposals', async () => {
  let nextId = 98;
  let inserts = 0;
  const { service } = loadProjects(async (sql, values) => {
    if (/^begin$|^commit$|pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
    if (isProposalLookup(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) { inserts += 1; nextId += 1; return { rows: [{ id: String(nextId), client_id: '10', title: values[1], description: values[2], status: 'draft' }] }; }
    if (/insert into project_memberships/i.test(sql)) return { rows: [{ id: String(nextId + 100), project_id: values[0], user_id: '20', membership_type: 'request', membership_status: 'pending', created_by: '20' }] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const first = await service.createProject(engineer, { clientId: '10', title: 'Alpha', description: '' });
  const second = await service.createProject(engineer, { clientId: '10', title: 'Beta', description: '' });
  assert.notEqual(first.id, second.id);
  assert.equal(inserts, 2);
});

test('proposal fails closed and rolls back for nonexistent, unapproved, or non-client IDs', async () => {
  const { service, calls } = loadProjects(async (sql) => {
    if (/^begin$|^rollback$|pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
    if (isProposalLookup(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  });

  await assert.rejects(service.createProject(engineer, { clientId: '404', title: 'Proposal', description: '' }), isConflict);
  assert.ok(calls.some((call) => /^rollback$/i.test(call.sql)));
  assert.ok(!calls.some((call) => /^commit$/i.test(call.sql)));
  assert.equal(calls.at(-1).sql, 'release');
});

test('proposal rolls back membership/transaction failures', async () => {
  const { service, calls } = loadProjects(async (sql) => {
    if (/^begin$|^rollback$|pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
    if (isProposalLookup(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) return { rows: [{ id: '99', client_id: '10', title: 'Proposal', description: '', status: 'draft' }] };
    if (/insert into project_memberships/i.test(sql)) throw new Error('duplicate or database failure');
    throw new Error(`Unexpected query: ${sql}`);
  });

  await assert.rejects(service.createProject(engineer, { clientId: '10', title: 'Proposal', description: '' }), /duplicate or database failure/);
  assert.ok(calls.some((call) => /^rollback$/i.test(call.sql)));
  assert.ok(!calls.some((call) => /^commit$/i.test(call.sql)));
});

test('rollback failure never masks the proposal transaction error', async () => {
  const primary = new Error('membership insert failed');
  const { service } = loadProjects(async (sql) => {
    if (/^begin$|pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
    if (isProposalLookup(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) return { rows: [{ id: '99' }] };
    if (/insert into project_memberships/i.test(sql)) throw primary;
    if (/^rollback$/i.test(sql)) throw new Error('rollback failed');
    throw new Error(`Unexpected query: ${sql}`);
  });
  await assert.rejects(service.createProject(engineer, { clientId: '10', title: 'Proposal' }), (error) => error === primary);
});

test('pending proposal membership cannot read detail or create a record; active membership can', async () => {
  let membershipStatus = 'pending';
  const project = { id: '99', client_id: '10', title: 'Proposal', description: '', status: 'draft' };
  const record = { id: '201', project_id: '99', record_id: '00000000-0000-0000-0000-000000000001', version: 1, title: 'Design' };
  const { service } = loadProjects(async (sql) => {
    const activeAccess = membershipStatus === 'active' && /membership_status='active'/i.test(sql);
    if (/select distinct p\.id/i.test(sql)) return { rows: activeAccess ? [project] : [] };
    if (/insert into project_records/i.test(sql)) return { rows: activeAccess ? [record] : [] };
    throw new Error(`Unexpected query: ${sql}`);
  });

  await assert.rejects(service.getProject(engineer, '99'), isNotFound);
  await assert.rejects(service.createRecord(engineer, '99', { title: 'Design', body: {} }), isNotFound);
  membershipStatus = 'active';
  assert.deepEqual(await service.getProject(engineer, '99'), project);
  assert.deepEqual(await service.createRecord(engineer, '99', { title: 'Design', body: {} }), record);
});

test('project proposal POST uses the authenticated session and returns 201; errors are safely mapped', async () => {
  const body = { clientId: '10', title: 'Proposal' };
  const created = { id: '99' };
  const request = { marker: 'request' };
  const success = loadProjectsRoute({ body, create: async () => created });
  const response = await success.route.POST(request);
  assert.equal(response.status, 201);
  assert.deepEqual(JSON.parse(JSON.stringify(response.value)), { ok: true, project: created });
  assert.deepEqual(success.calls.filter(([name]) => name === 'session').map((call) => call.slice(1)), [[]]);
  assert.equal(success.calls.find(([name]) => name === 'create')[1], engineer);
  assert.equal(success.calls.find(([name]) => name === 'create')[2], body);

  const failure = loadProjectsRoute({ create: async () => { throw new Error('database details'); } });
  const failedResponse = await failure.route.POST(request);
  assert.equal(failedResponse.status, 500);
  assert.deepEqual(JSON.parse(JSON.stringify(failedResponse.value)), { ok: false, error: 'safe' });
  assert.equal(failure.calls.filter(([name]) => name === 'error').length, 1);
});

test('API and engineer UI expose proposals without role-incompatible body shortcuts', () => {
  assert.ok(existsSync(new URL('app/api/clients/route.ts', root)));
  const route = read('app/api/projects/route.ts');
  const clientsRoute = read('app/api/clients/route.ts');
  const projectsClient = read('app/projects/ProjectsClient.tsx');
  const approvalClient = read('app/admin/approve/ApprovalClient.tsx');

  assert.match(route, /requireApiSession\(\)/, 'project POST must admit either approved project role and let the service fail closed');
  assert.match(route, /createProject/);
  assert.match(clientsRoute, /requireApiSession\('engineer'\)/);
  assert.match(clientsRoute, /listAvailableClients/);
  assert.match(projectsClient, /Add new project/);
  assert.match(projectsClient, /\/api\/clients/);
  assert.match(projectsClient, /clientId/);
  assert.match(projectsClient, /Client/);
  assert.match(projectsClient, /pending client approval/i);
  assert.match(projectsClient, /proposalBusy/);
  assert.doesNotMatch(projectsClient, /href="\/dashboard"[^>]*>Files dashboard/);
  assert.doesNotMatch(approvalClient, /href="\/projects"[^>]*>Projects/);
});
