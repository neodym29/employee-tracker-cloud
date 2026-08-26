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

test('client formation creates pending invitations, never active co-former memberships', async () => {
  const project = { id: '77', client_id: '10', title: 'Formation', description: '', status: 'open', approval_status: 'approved', proposal_kind: null, creation_payload_fingerprint: '' };
  const invitations = [
    { id: '101', project_id: '77', user_id: '20', membership_type: 'invitation', membership_status: 'pending', is_project_proposal: false, created_by: '10' },
    { id: '102', project_id: '77', user_id: '21', membership_type: 'invitation', membership_status: 'pending', is_project_proposal: false, created_by: '10' },
  ];
  let accepted = false;
  const { service } = loadProjects(async (sql, values) => {
    if (/^(begin|commit)$/i.test(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) { project.creation_payload_fingerprint = values.at(-1); return { rows: [project] }; }
    if (/insert into project_memberships/i.test(sql)) {
      assert.match(sql, /'invitation','pending'/i);
      assert.doesNotMatch(sql, /'creator','active'/i);
      assert.match(sql, /account_type='engineer'[\s\S]*approval_status='approved'/i);
      return { rows: invitations };
    }
    if (/from projects p/i.test(sql) && /creation_request_key/i.test(sql)) return { rows: [project] };
    if (/from project_memberships/i.test(sql)) return { rows: invitations };
    if (/select distinct p\.id/i.test(sql)) {
      assert.match(sql, /membership_status='active'/i);
      return { rows: accepted ? [project] : [] };
    }
    if (/for update of pm,p/i.test(sql)) {
      if (values[0] !== '77' || values[1] !== '101' || values[2] !== '20') return { rows: [] };
      return { rows: [{ ...invitations[0], client_id: '10', project_status: 'open', approval_status: 'approved', proposal_kind: null, creation_requested_by: '10' }] };
    }
    if (/update project_memberships set/i.test(sql)) {
      accepted = true;
      return { rows: [{ ...invitations[0], membership_status: 'active' }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const result = await service.createProject(client, { title: 'Formation', status: 'open', engineerIds: ['20', '21'], requestKey });
  assert.deepEqual(plain(result.memberships), invitations);
  await assert.rejects(service.getProject(engineer, '77'), (error) => error?.status === 404);
  await service.respondToMembership(engineer, '77', '101', 'accept');
  assert.deepEqual(await service.getProject(engineer, '77'), project);
});

test('engineer formation creates a pending request and cannot access workspace until owning client approves it', async () => {
  const project = { id: '99', client_id: '10', title: 'Proposal', description: '', status: 'draft', approval_status: 'pending', proposal_kind: 'engineer_client', creation_payload_fingerprint: '' };
  const membership = { id: '103', project_id: '99', user_id: '20', membership_type: 'request', membership_status: 'pending', is_project_proposal: true, created_by: '20' };
  let approved = false;
  const { service } = loadProjects(async (sql, values) => {
    if (/^(begin|commit)$/i.test(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) { project.creation_payload_fingerprint = values.at(-1); return { rows: [project] }; }
    if (/insert into project_memberships/i.test(sql)) {
      assert.match(sql, /'request','pending'/i);
      assert.doesNotMatch(sql, /'creator','active'/i);
      return { rows: [membership] };
    }
    if (/from projects p/i.test(sql) && /creation_request_key/i.test(sql)) return { rows: [project] };
    if (/from project_memberships/i.test(sql) && !/for update of pm,p/i.test(sql)) return { rows: [{ ...membership, membership_status: approved ? 'active' : 'pending' }] };
    if (/select distinct p\.id/i.test(sql)) {
      assert.match(sql, /membership_status='active'/i);
      return { rows: approved ? [project] : [] };
    }
    if (/for update of pm,p/i.test(sql)) {
      if (values[2] !== '10') return { rows: [] };
      return { rows: [{ ...membership, client_id: '10', project_status: project.status, approval_status: project.approval_status, proposal_kind: project.proposal_kind, creation_requested_by: '20' }] };
    }
    if (/update projects set approval_status/i.test(sql)) {
      project.approval_status = values[2]; project.status = values[3];
      return { rows: [{ approval_status: project.approval_status, status: project.status }] };
    }
    if (/update project_memberships set/i.test(sql)) {
      approved = true;
      return { rows: [{ ...membership, membership_status: 'active' }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const created = await service.createProject(engineer, { clientId: '10', title: 'Proposal', requestKey });
  assert.equal(created.membership.membership_status, 'pending');
  await assert.rejects(service.getProject(engineer, '99'), (error) => error?.status === 404);
  await assert.rejects(service.respondToMembership({ ...client, id: '11' }, '99', '103', 'approve'), (error) => error?.status === 404);
  await service.respondToMembership(client, '99', '103', 'approve');
  assert.deepEqual(await service.getProject(engineer, '99'), project);
});

test('projects UI names engineer creation as a proposal, does not navigate before consent, and exposes client request decisions', () => {
  assert.match(projectsUi, /Project proposal/);
  assert.match(projectsUi, /await load\(\)/);
  assert.match(projectsUi, /accountType\s*===\s*'client'[\s\S]*router\.push/);
  assert.doesNotMatch(projectsUi, /active workspace opens immediately after creation/i);
  assert.match(projectsUi, /\/requests/);
  assert.match(projectsUi, /decideMembership\(project\.id, membership\.id, 'approve'\)/);
  assert.match(projectsUi, /decideMembership\(project\.id, membership\.id, 'reject'\)/);
  assert.match(projectsUi, /Platform Admins approve accounts; project clients and engineers approve collaboration\./);
});
