import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('lib/projects.ts', root), 'utf8');
const routeSource = readFileSync(new URL('app/api/projects/route.ts', root), 'utf8');
const engineer = { id: '20', role: 'employee', account_type: 'engineer' };
const client = { id: '10', role: 'employee', account_type: 'client' };
const requestKey = '7d444840-9dc0-4b9b-b785-31f1f14f18b8';

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
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module, exports: module.exports, Buffer, console,
    require(specifier) {
      if (specifier === 'node:crypto') return crypto;
      if (specifier === './db') return { ensureSchema: async () => {}, getPool: () => pool };
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  return { service: module.exports, calls };
}

function isConflict(error) {
  assert.equal(error?.constructor?.name, 'ProjectServiceError');
  assert.equal(error?.status, 409);
  assert.equal(error?.code, 'conflict');
  return true;
}

function loadRoute(created) {
  const javascript = ts.transpileModule(routeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module, exports: module.exports,
    require(specifier) {
      if (specifier === 'next/server') return { NextResponse: { json: (value, init = {}) => ({ value, status: init.status ?? 200 }) } };
      if (specifier === '@/lib/api') return { assertSameOrigin() {}, async requireApiSession() { return engineer; }, async jsonBody() { return { clientId: '10', title: 'Trace model' }; }, apiErrorResponse(error) { throw error; } };
      if (specifier === '@/lib/projects') return { async createProject() { return created; }, async listProjects() { return []; } };
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  return module.exports;
}

test('approved-client discovery remains engineer-only', async () => {
  const rows = [{ id: '10', display_name: 'Acme' }];
  const { service } = loadProjects(async (sql) => {
    assert.match(sql, /select id,display_name from app_users/i);
    assert.match(sql, /account_type='client'[\s\S]*approval_status='approved'/i);
    return { rows };
  });
  assert.deepEqual(await service.listAvailableClients(engineer), rows);
  await assert.rejects(service.listAvailableClients(client), (error) => error?.status === 403);
});

test('engineer creation uses one transaction to create a client-owned project and ACTIVE creator membership', async () => {
  const project = { id: '99', client_id: '10', title: 'Trace model', description: 'Build it', status: 'draft' };
  const membership = { id: '101', project_id: '99', user_id: '20', membership_type: 'creator', membership_status: 'active', created_by: '20' };
  const { service, calls } = loadProjects(async (sql, values) => {
    if (/^begin$|^commit$|^rollback$/i.test(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) {
      assert.match(sql, /from app_users/i);
      assert.match(sql, /account_type='client'[\s\S]*approval_status='approved'/i);
      assert.match(sql, /creation_request_key/i);
      assert.deepEqual(Array.from(values).slice(0, 6), ['10', 'Trace model', 'Build it', 'draft', '20', requestKey]);
      assert.match(values[6], /^[a-f0-9]{64}$/);
      project.creation_payload_fingerprint = values[6];
      return { rows: [project] };
    }
    if (/insert into project_memberships/i.test(sql)) {
      assert.match(sql, /'creator','active'/i);
      assert.deepEqual(Array.from(values), ['99', '20']);
      return { rows: [membership] };
    }
    if (/from projects p/i.test(sql) && /creation_request_key/i.test(sql)) return { rows: [project] };
    if (/from project_memberships/i.test(sql) && /membership_type='creator'/i) return { rows: [membership] };
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await service.createProject(engineer, { clientId: '10', title: ' Trace model ', description: ' Build it ', status: 'open', requestKey });
  const { creation_payload_fingerprint: _fingerprint, ...publicProject } = project;
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ...publicProject, memberships: [membership], membership });
  assert.equal(result.id, '99', 'the new accessible dashboard ID must be returned immediately');
  assert.equal(calls.filter(({ sql }) => /^begin$/i.test(sql)).length, 1);
  assert.equal(calls.filter(({ sql }) => /^commit$/i.test(sql)).length, 1);
  assert.equal(calls.filter(({ sql }) => /^rollback$/i.test(sql)).length, 0);
  assert.deepEqual(calls.map(({ sql }) => sql === 'connect' || sql === 'release' || /^(begin|commit)$/i.test(sql) ? sql : /insert into projects/i.test(sql) ? 'project insert' : /insert into project_memberships/i.test(sql) ? 'membership insert' : /from projects p/i.test(sql) ? 'canonical lookup' : /from project_memberships/i.test(sql) ? 'creator lookup' : 'unexpected'), ['connect', 'begin', 'project insert', 'membership insert', 'canonical lookup', 'creator lookup', 'commit', 'release']);
});

test('invalid or unapproved client rolls back the project transaction without creating membership', async () => {
  const { service, calls } = loadProjects(async (sql) => {
    if (/^begin$|^rollback$/i.test(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) return { rows: [] };
    if (/from projects p/i.test(sql) && /creation_request_key/i.test(sql)) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  await assert.rejects(service.createProject(engineer, { clientId: '404', title: 'New project', requestKey }), isConflict);
  assert.equal(calls.filter(({ sql }) => /^rollback$/i.test(sql)).length, 1);
  assert.equal(calls.filter(({ sql }) => /insert into project_memberships/i.test(sql)).length, 0);
  assert.equal(calls.filter(({ sql }) => /^commit$/i.test(sql)).length, 0);
  assert.equal(calls.at(-1).sql, 'release');
});

test('membership insertion failure rolls back and preserves the primary error', async () => {
  const primary = new Error('membership insert failed');
  const { service, calls } = loadProjects(async (sql) => {
    if (/^begin$/i.test(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) return { rows: [{ id: '99' }] };
    if (/insert into project_memberships/i.test(sql)) throw primary;
    if (/^rollback$/i.test(sql)) throw new Error('rollback failed');
    throw new Error(`Unexpected query: ${sql}`);
  });
  await assert.rejects(service.createProject(engineer, { clientId: '10', title: 'New project', requestKey }), (error) => error === primary);
  assert.ok(calls.some(({ sql }) => /^rollback$/i.test(sql)));
});

test('ACTIVE creating engineer can immediately read the returned project workspace', async () => {
  const project = { id: '99', client_id: '10', title: 'New project', description: '', status: 'draft' };
  const { service } = loadProjects(async (sql) => {
    assert.match(sql, /membership_status='active'/i);
    if (/select distinct p\.id/i.test(sql)) return { rows: [project] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  assert.deepEqual(await service.getProject(engineer, '99'), project);
});

test('project POST returns the immediately usable project ID in its 201 body', async () => {
  const route = loadRoute({ id: '99', membership: { membership_status: 'active' } });
  const response = await route.POST({});
  assert.equal(response.status, 201);
  assert.equal(response.value.project.id, '99');
  assert.equal(response.value.project.membership.membership_status, 'active');
});

test('creation fails closed before database access when the request key is missing or malformed', async () => {
  const { service, calls } = loadProjects(async () => { throw new Error('database must not be reached'); });
  for (const invalid of [undefined, '', 'not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
    await assert.rejects(service.createProject(client, { title: 'New project', requestKey: invalid }), (error) => error?.status === 400 && error?.code === 'invalid_request');
  }
  assert.equal(calls.length, 0);
});

test('client creation uses durable request-key conflict handling and transactionally replays the same project', async () => {
  const project = { id: '77', client_id: '10', title: 'Client project', description: '', status: 'open' };
  let attempts = 0;
  const { service, calls } = loadProjects(async (sql, values) => {
    if (/^begin$|^commit$/i.test(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) {
      attempts += 1;
      assert.match(sql, /on conflict\s*\(creation_requested_by,\s*creation_request_key\)\s*do nothing/i);
      assert.deepEqual(Array.from(values).slice(0, 6), ['10', 'Client project', '', 'open', '10', requestKey]);
      assert.match(values[6], /^[a-f0-9]{64}$/);
      project.creation_payload_fingerprint = values[6];
      return { rows: attempts === 1 ? [project] : [] };
    }
    if (/from projects p/i.test(sql) && /creation_request_key/i.test(sql)) return { rows: [project] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const input = { title: 'Client project', status: 'open', requestKey };
  assert.equal((await service.createProject(client, input)).id, '77');
  assert.equal((await service.createProject(client, input)).id, '77');
  assert.equal(calls.filter(({ sql }) => /insert into projects/i.test(sql)).length, 2);
  assert.equal(calls.filter(({ sql }) => /creation_request_key/i.test(sql) && /from projects p/i.test(sql)).length, 2);
});

test('creation UI says Create project, never proposal language, and navigates to returned workspace', () => {
  const ui = readFileSync(new URL('app/projects/ProjectsClient.tsx', root), 'utf8');
  assert.match(ui, /useRouter/);
  assert.match(ui, /router\.push\(`\/projects\/\$\{data\.project\.id\}`\)/);
  assert.match(ui, /Create project/);
  assert.doesNotMatch(ui, /propos(?:e|al|ing)/i);
  assert.match(ui, /\/api\/clients/);
  assert.match(ui, /Request to join/, 'joining existing projects remains available');
  assert.match(ui, /crypto\.randomUUID\(\)/, 'the browser must generate the request UUID');
  assert.match(ui, /requestKey/, 'the request UUID must be submitted');
  assert.match(ui, /useRef/, 'the request UUID and synchronous submit lock must survive retries/renders');
  assert.match(ui, /fieldset[^>]*disabled=\{createBusy\}/, 'all create controls remain locked while creation/redirect is pending');
});
