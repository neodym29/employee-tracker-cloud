import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('lib/projects.ts', root), 'utf8');
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
      if (specifier === './project-agent-documents') return { async loadProjectAgentStructuredData() { return { memberRoster: [], projectStatistics: {} }; }, async ensureCanonicalProjectDocuments() {} };
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  return { service: module.exports, calls };
}

const joinRequest = () => ({
  id: '103', project_id: '99', user_id: '20', client_id: '10', created_by: '20',
  membership_type: 'request', membership_status: 'pending', approval_status: 'approved',
  project_status: 'open', responded_at: null,
});

test('ordinary open-project join decisions remain owner-controlled, replay safe, and never transition the project', async () => {
  const row = joinRequest();
  const { service, calls } = serviceFor(row);
  await assert.rejects(service.respondToMembership({ ...clientUser, id: '11' }, '99', '103', 'approve'), (error) => error?.status === 404);
  const first = await service.respondToMembership(clientUser, '99', '103', 'approve');
  assert.equal(first.membership_status, 'active');
  assert.equal((await service.respondToMembership(clientUser, '99', '103', 'approve')).membership_status, 'active');
  await assert.rejects(service.respondToMembership(clientUser, '99', '103', 'reject'), (error) => error?.status === 409);
  assert.equal(calls.some(({ sql }) => /update projects set approval_status/i.test(sql)), false);
});

test('later invitation decline remains engineer-controlled and replay safe', async () => {
  const row = { ...joinRequest(), membership_type: 'invitation', created_by: '10' };
  const { service } = serviceFor(row);
  assert.equal((await service.respondToMembership(engineerUser, '99', '103', 'decline')).membership_status, 'declined');
  assert.equal((await service.respondToMembership(engineerUser, '99', '103', 'decline')).membership_status, 'declined');
  await assert.rejects(service.respondToMembership(engineerUser, '99', '103', 'accept'), (error) => error?.status === 409);
});

test('immediate formation has no proposal writer or proposal decision state machine', () => {
  assert.doesNotMatch(source, /'pending','engineer_client'/i);
  assert.doesNotMatch(source, /'request','pending',true/i);
  assert.doesNotMatch(source, /row\.is_project_proposal|isProposal|Project proposal has already been decided/i);
  assert.match(source, /version:\s*2/, 'changed formation semantics must use a new request fingerprint version');
  assert.match(source, /'approved',null/);
  assert.match(source, /'creator','active',false/);
});

test('authorization remains fail closed and reusable schema setup contains no data-specific repair', () => {
  assert.match(source, /membership_status='active'/i);
  assert.match(source, /approval_status='approved'/i);
  assert.match(source, /p\.approval_status='approved' and p\.status='open'/i);
  assert.doesNotMatch(ensure, /where\s+(?:p\.)?id\s*=\s*6\b/i);
  assert.doesNotMatch(ensure, /set\s+membership_status\s*=\s*'active'[\s\S]*where[\s\S]*(proposal_kind|is_project_proposal)/i);
});

test('rolling compatibility retains the obsolete proposal trigger until old writers are drained', () => {
  assert.match(ensure, /create or replace function enforce_project_proposal_membership/i);
  assert.match(ensure, /create trigger project_proposal_membership_guard/i);
  assert.doesNotMatch(ensure, /drop function if exists (?:public\.)?enforce_project_proposal_membership/i);
  assert.doesNotMatch(ensure, /where\s+(?:p\.)?id\s*=\s*6\b/i);
  assert.equal(existsSync(new URL('migrations/015_retire_project_proposal_workflow.sql', root)), false,
    'trigger retirement must be a later drain-complete release, not this rolling-compatible writer');
});
