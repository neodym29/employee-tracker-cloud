import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('lib/projects.ts', root), 'utf8');
const migration = readFileSync(new URL('migrations/010_project_proposal_approval.sql', root), 'utf8');
const hardeningMigrationUrl = new URL('migrations/011_project_proposal_fail_closed.sql', root);
const hardeningMigration = existsSync(hardeningMigrationUrl) ? readFileSync(hardeningMigrationUrl, 'utf8') : '';
const compatibilityMigrationUrl = new URL('migrations/012_project_proposal_membership_compatibility.sql', root);
const compatibilityMigration = existsSync(compatibilityMigrationUrl) ? readFileSync(compatibilityMigrationUrl, 'utf8') : '';
const decisionCompatibilityMigrationUrl = new URL('migrations/013_project_proposal_decision_compatibility.sql', root);
const decisionCompatibilityMigration = existsSync(decisionCompatibilityMigrationUrl) ? readFileSync(decisionCompatibilityMigrationUrl, 'utf8') : '';
const enforcementMigrationUrl = new URL('migrations/014_project_approval_default_enforcement.sql', root);
const enforcementMigration = existsSync(enforcementMigrationUrl) ? readFileSync(enforcementMigrationUrl, 'utf8') : '';
const ensure = readFileSync(new URL('lib/db.ts', root), 'utf8');
const clientUser = { id: '10', role: 'employee', account_type: 'client' };
const engineerUser = { id: '20', role: 'employee', account_type: 'engineer' };

function serviceFor(row) {
  const calls = [];
  const connection = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/^(begin|commit|rollback)$/i.test(sql)) return { rows: [] };
      if (/for update of pm,p/i.test(sql)) {
        const authorized = (values[3] === 'client' && values[2] === row.client_id)
          || (values[3] === 'engineer' && values[2] === row.user_id);
        return { rows: authorized ? [{ ...row }] : [] };
      }
      if (/update projects set approval_status/i.test(sql)) {
        if (row.approval_status !== 'pending') return { rows: [] };
        row.approval_status = values[2]; row.project_status = values[3];
        return { rows: [{ approval_status: row.approval_status, status: row.project_status }] };
      }
      if (/update project_memberships set/i.test(sql)) {
        if (row.membership_status !== 'pending') return { rows: [] };
        row.membership_status = values[2]; row.responded_at = 'now';
        return { rows: [{ id: row.id, project_id: row.project_id, user_id: row.user_id, membership_status: row.membership_status, responded_at: row.responded_at }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const pool = { connect: async () => connection, query: connection.query.bind(connection) };
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, {
    module, exports: module.exports, Buffer, console,
    require(specifier) {
      if (specifier === 'node:crypto') return crypto;
      if (specifier === './db') return { ensureSchema: async () => {}, getPool: () => pool };
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  return { service: module.exports, calls };
}

const proposal = () => ({
  id: '103', project_id: '99', user_id: '20', client_id: '10', created_by: '20',
  membership_type: 'request', membership_status: 'pending', creation_requested_by: '20',
  approval_status: 'pending', proposal_kind: 'engineer_client', is_project_proposal: true, project_status: 'draft', responded_at: null,
});

test('proposal decisions atomically transition project and are replay safe', async () => {
  const row = proposal();
  const { service, calls } = serviceFor(row);
  const first = await service.respondToMembership(clientUser, '99', '103', 'approve');
  assert.equal(first.membership_status, 'active');
  assert.equal(first.approval_status, 'approved');
  assert.equal(first.project_status, 'open');
  const replay = await service.respondToMembership(clientUser, '99', '103', 'approve');
  assert.equal(replay.membership_status, 'active');
  row.project_status = 'active';
  const replayAfterLifecycleChange = await service.respondToMembership(clientUser, '99', '103', 'approve');
  assert.equal(replayAfterLifecycleChange.membership_status, 'active');
  assert.equal(replayAfterLifecycleChange.approval_status, 'approved');
  await assert.rejects(service.respondToMembership(clientUser, '99', '103', 'reject'), (error) => error?.status === 409);
  assert.equal(calls.filter(({ sql }) => /update projects set approval_status/i.test(sql)).length, 1);
});

test('proposal rejection is terminal, canonical on retry, and cross-client hidden', async () => {
  const row = proposal();
  const { service } = serviceFor(row);
  await assert.rejects(service.respondToMembership({ ...clientUser, id: '11' }, '99', '103', 'reject'), (error) => error?.status === 404);
  const rejected = await service.respondToMembership(clientUser, '99', '103', 'reject');
  assert.equal(rejected.approval_status, 'rejected');
  assert.equal(rejected.project_status, 'archived');
  assert.equal((await service.respondToMembership(clientUser, '99', '103', 'reject')).membership_status, 'rejected');
  await assert.rejects(service.respondToMembership(clientUser, '99', '103', 'approve'), (error) => error?.status === 409);
});

test('ordinary join decisions on an approved engineer-originated project never transition the project', async () => {
  const row = { ...proposal(), is_project_proposal: false, created_by: '30', creation_requested_by: '20', approval_status: 'approved', project_status: 'open' };
  const { service, calls } = serviceFor(row);
  await service.respondToMembership(clientUser, '99', '103', 'approve');
  assert.equal(calls.some(({ sql }) => /update projects set approval_status/i.test(sql)), false);
  assert.equal(row.project_status, 'open');
});

test('invitation decline is replay safe and opposite accept conflicts', async () => {
  const row = { ...proposal(), membership_type: 'invitation', created_by: '10', creation_requested_by: '10', approval_status: 'approved', project_status: 'open' };
  const { service } = serviceFor(row);
  assert.equal((await service.respondToMembership(engineerUser, '99', '103', 'decline')).membership_status, 'declined');
  assert.equal((await service.respondToMembership(engineerUser, '99', '103', 'decline')).membership_status, 'declined');
  await assert.rejects(service.respondToMembership(engineerUser, '99', '103', 'accept'), (error) => error?.status === 409);
});

test('authorization is fail closed while reusable schema setup never rewrites legacy collaboration state heuristically', () => {
  assert.match(source, /approval_status='approved'[\s\S]*client_id=.*membership/i);
  assert.match(source, /p\.approval_status='approved' and p\.status='open'/i);
  for (const text of [migration, ensure]) {
    assert.match(text, /update projects set approval_status='approved' where approval_status is null/i);
    assert.doesNotMatch(text, /set approval_status='pending',status='draft'/i);
    assert.doesNotMatch(text, /set membership_type='request',membership_status='pending'/i);
    assert.doesNotMatch(text, /set membership_type='invitation',membership_status='pending'/i);
    assert.doesNotMatch(text, /update\s+(?:public\.)?projects[\s\S]{0,300}set approval_status='rejected',status='archived'[\s\S]{0,300}where[\s\S]{0,200}(creation_requested_by|proposal_kind\s+is\s+null)/i);
    assert.doesNotMatch(text, /update\s+(?:public\.)?project_memberships[\s\S]{0,300}set membership_status='rejected'[\s\S]{0,300}where[\s\S]{0,200}(membership_type='creator'|created_by=user_id)/i);
  }
});
test('schema and every writer require explicit approval state and an explicit proposal discriminator', () => {
  assert.match(hardeningMigration, /alter table projects alter column approval_status drop default/i);
  assert.match(compatibilityMigration, /alter table projects alter column approval_status set default 'approved'/i);
  assert.match(enforcementMigration, /alter table projects alter column approval_status drop default/i);
  assert.match(hardeningMigration, /add column if not exists proposal_kind text/i);
  assert.match(compatibilityMigration, /project_memberships\s+add column if not exists is_project_proposal boolean not null default false/i);
  assert.match(compatibilityMigration, /unique index[\s\S]*where is_project_proposal/i);
  assert.match(decisionCompatibilityMigration, /create or replace function enforce_project_proposal_membership/i);
  assert.match(decisionCompatibilityMigration, /new\.membership_status='active'[\s\S]*approval_status='approved'[\s\S]*status='open'/i);
  assert.match(decisionCompatibilityMigration, /new\.membership_status='rejected'[\s\S]*approval_status='rejected'[\s\S]*status='archived'/i);
  assert.match(decisionCompatibilityMigration, /before insert or update on (?:public\.)?project_memberships/i);
  assert.match(hardeningMigration, /proposal_kind[\s\S]*approval_status='pending'[\s\S]*status='draft'/i);
  assert.match(hardeningMigration, /proposal_kind[\s\S]*approval_status='rejected'[\s\S]*status='archived'/i);
  assert.match(ensure, /approval_status text not null check/i);
  assert.doesNotMatch(ensure, /alter table projects alter column approval_status drop default/i);
  assert.match(ensure, /proposal_kind text/i);
  assert.match(ensure, /is_project_proposal boolean not null default false/i);
  assert.match(ensure, /create or replace function enforce_project_proposal_membership/i);
  assert.match(ensure, /create trigger project_proposal_membership_guard/i);
  assert.match(source, /insert into projects\(client_id,title,description,status,approval_status,proposal_kind/i);
  assert.match(source, /insert into project_memberships\(project_id,user_id,membership_type,membership_status,is_project_proposal,created_by\)/i);
});

test('membership decisions use only the durable proposal discriminator, never legacy actor heuristics', () => {
  assert.match(source, /coalesce\(pm\.is_project_proposal,false\) as is_project_proposal/i);
  assert.match(source, /row\.is_project_proposal === true/);
  assert.doesNotMatch(source, /approval_status='pending'[\s\S]*creation_requested_by=pm\.user_id[\s\S]*pm\.created_by=pm\.user_id[\s\S]*as is_project_proposal/i);
});
