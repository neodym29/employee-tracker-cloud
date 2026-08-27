import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const projectSource = readFileSync(new URL('lib/projects.ts', root), 'utf8');
const projectsUi = readFileSync(new URL('app/projects/ProjectsClient.tsx', root), 'utf8');
const client = { id: '10', role: 'employee', account_type: 'client' };
const engineer = { id: '20', role: 'employee', account_type: 'engineer' };
const requestKey = '7d444840-9dc0-4b9b-b785-31f1f14f18b8';
const plain = (value) => JSON.parse(JSON.stringify(value));

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
  const javascript = ts.transpileModule(projectSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
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

test('client formation makes every selected approved engineer an active creator atomically', async () => {
  const project = { id: '77', client_id: '10', title: 'Formation', description: '', status: 'open', approval_status: 'approved', proposal_kind: null, creation_payload_fingerprint: '' };
  const creators = [
    { id: '101', project_id: '77', user_id: '20', membership_type: 'creator', membership_status: 'active', is_project_proposal: false, created_by: '10' },
    { id: '102', project_id: '77', user_id: '21', membership_type: 'creator', membership_status: 'active', is_project_proposal: false, created_by: '10' },
  ];
  const { service, calls } = loadProjects(async (sql, values) => {
    if (/^(begin|commit)$/i.test(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) { project.creation_payload_fingerprint = values.at(-1); return { rows: [project] }; }
    if (/insert into project_memberships/i.test(sql)) {
      assert.match(sql, /'creator','active'/i);
      assert.doesNotMatch(sql, /'invitation','pending'/i);
      assert.match(sql, /account_type='engineer'[\s\S]*approval_status='approved'/i);
      return { rows: creators };
    }
    if (/from projects p/i.test(sql) && /creation_request_key/i.test(sql)) return { rows: [project] };
    if (/from project_memberships/i.test(sql)) return { rows: creators };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const result = await service.createProject(client, { title: 'Formation', status: 'open', engineerIds: ['20', '21'], requestKey });
  assert.deepEqual(plain(result.memberships), creators);
  assert.equal(calls.filter(({ sql }) => /^commit$/i.test(sql)).length, 1);
  assert.equal(calls.filter(({ sql }) => /^rollback$/i.test(sql)).length, 0);
});

test('engineer formation immediately creates an approved open client-owned project and active creator membership', async () => {
  const project = { id: '99', client_id: '10', title: 'Immediate project', description: '', status: 'open', approval_status: 'approved', proposal_kind: null, creation_payload_fingerprint: '' };
  const creator = { id: '103', project_id: '99', user_id: '20', membership_type: 'creator', membership_status: 'active', is_project_proposal: false, created_by: '20' };
  const { service } = loadProjects(async (sql, values) => {
    if (/^(begin|commit)$/i.test(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) {
      assert.match(sql, /select id,[\s\S]*'open','approved',null/i);
      assert.match(sql, /account_type='client'[\s\S]*approval_status='approved'/i);
      project.creation_payload_fingerprint = values.at(-1);
      return { rows: [project] };
    }
    if (/insert into project_memberships/i.test(sql)) {
      assert.match(sql, /'creator','active',false/i);
      assert.doesNotMatch(sql, /'request','pending'/i);
      return { rows: [creator] };
    }
    if (/from projects p/i.test(sql) && /creation_request_key/i.test(sql)) return { rows: [project] };
    if (/from project_memberships/i.test(sql)) return { rows: [creator] };
    if (/select distinct p\.id/i.test(sql)) return { rows: [project] };
    throw new Error(`Unexpected query: ${sql}`);
  });

  const created = await service.createProject(engineer, { clientId: '10', title: 'Immediate project', requestKey });
  assert.equal(created.status, 'open');
  assert.equal(created.approval_status, 'approved');
  assert.equal(created.membership.membership_type, 'creator');
  assert.equal(created.membership.membership_status, 'active');
  assert.deepEqual(await service.getProject(engineer, '99'), project);
});

test('invalid counterpart selection rolls back all immediate formation writes', async () => {
  const { service, calls } = loadProjects(async (sql) => {
    if (/^begin$|^rollback$/i.test(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) return { rows: [{ id: '77', creation_payload_fingerprint: 'a'.repeat(64) }] };
    if (/insert into project_memberships/i.test(sql)) return { rows: [{ user_id: '20' }] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  await assert.rejects(
    service.createProject(client, { title: 'Formation', engineerIds: ['20', '404'], requestKey }),
    (error) => error?.status === 409 && error?.code === 'conflict',
  );
  assert.equal(calls.filter(({ sql }) => /^rollback$/i.test(sql)).length, 1);
  assert.equal(calls.filter(({ sql }) => /^commit$/i.test(sql)).length, 0);
});

test('later invitations and ordinary open-project join requests remain pending', () => {
  assert.match(projectSource, /inviteEngineer[\s\S]*'invitation','pending'/i);
  assert.match(projectSource, /requestMembership[\s\S]*'request','pending'/i);
  assert.match(projectSource, /respondToMembership/);
  assert.match(projectsUi, /Request to join/);
  assert.match(projectsUi, /Accept/);
  assert.match(projectsUi, /Decline/);
  assert.match(projectsUi, /Pending join requests/);
});

test('formation UI navigates both roles directly and contains no obsolete proposal approval copy or sections', () => {
  assert.match(projectsUi, /router\.push\(`\/projects\/\$\{data\.project\.id\}`\)/);
  assert.doesNotMatch(projectsUi, /accountType\s*===\s*'client'[\s\S]{0,200}router\.push/);
  assert.match(projectsUi, /Select an approved client/);
  assert.match(projectsUi, /Create project/);
  assert.match(projectsUi, /Start project/);
  assert.match(projectsUi, /Selected approved engineers join immediately as project creators/i);
  assert.doesNotMatch(projectsUi, /project proposal|client approval|awaiting client approval|pending project proposals|rejected project proposals/i);
});
