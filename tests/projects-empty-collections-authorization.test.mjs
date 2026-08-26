import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/projects.ts', import.meta.url), 'utf8');

const owner = { id: '10', role: 'user', account_type: 'client' };
const member = { id: '20', role: 'user', account_type: 'engineer' };
const outsider = { id: '30', role: 'user', account_type: 'engineer' };
const otherClient = { id: '40', role: 'user', account_type: 'client' };

function loadProjects() {
  const queries = [];
  const pool = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (/from project_(?:records|artifacts) resource/i.test(sql)) return { rows: [] };
      if (/from project_memberships pm/i.test(sql)) return { rows: [] };
      if (/select distinct p\.id/i.test(sql)) {
        const userId = String(values[1]);
        return { rows: userId === owner.id || userId === member.id ? [{ id: '2', client_id: owner.id, title: 'Created workspace', status: 'draft' }] : [] };
      }
      if (/update projects set/i.test(sql)) {
        return { rows: String(values[1]) === owner.id ? [{ id: '2', client_id: owner.id, title: values[2], description: values[3], status: values[4] }] : [] };
      }
      if (/select 1[\s\S]*from projects p/i.test(sql)) {
        const userId = String(values[1]);
        const ownerOnly = !/project_memberships access_membership/i.test(sql);
        const authorized = userId === owner.id || (!ownerOnly && userId === member.id);
        return { rows: authorized ? [{ '?column?': 1 }] : [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
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
  });
  return { service: module.exports, queries };
}

function isNotFound(error) {
  assert.equal(error?.constructor?.name, 'ProjectServiceError');
  assert.equal(error?.status, 404);
  assert.equal(error?.code, 'not_found');
  assert.equal(error?.message, 'Project not found');
  return true;
}

for (const method of ['listRecords', 'listArtifacts']) {
  test(`${method} returns an empty collection only to an authorized owner or active member`, async () => {
    const { service } = loadProjects();

    assert.deepEqual(await service[method](owner, '2'), []);
    assert.deepEqual(await service[method](member, '2'), []);
    await assert.rejects(service[method](outsider, '2'), isNotFound);
  });
}

test('creator access covers project detail while only the selected client controls project status', async () => {
  const { service } = loadProjects();
  assert.equal((await service.getProject(owner, '2')).client_id, owner.id);
  assert.equal((await service.getProject(member, '2')).client_id, owner.id);
  await assert.rejects(service.getProject(outsider, '2'), isNotFound);

  const changed = await service.updateProject(owner, '2', { title: 'Renamed', description: '', status: 'active' });
  assert.equal(changed.status, 'active');
  await assert.rejects(service.updateProject(otherClient, '2', { title: 'Hijack', description: '', status: 'archived' }), isNotFound);
  await assert.rejects(service.updateProject(member, '2', { title: 'Engineer edit', description: '', status: 'archived' }), (error) => error?.status === 403);
});

test('listProjectMemberships fails closed for an empty project the client does not own', async () => {
  const { service } = loadProjects();

  assert.deepEqual(await service.listProjectMemberships(owner, '2'), []);
  await assert.rejects(service.listProjectMemberships(otherClient, '2'), isNotFound);
});
