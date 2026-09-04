import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const projectSource = readFileSync(new URL('lib/projects.ts', root), 'utf8');
const gitRemoteSource = readFileSync(new URL('lib/git-remote.ts', root), 'utf8');
const clientSource = readFileSync(new URL('app/projects/ProjectsClient.tsx', root), 'utf8');
const client = { id: '10', role: 'employee', account_type: 'client' };
const requestKey = '7d444840-9dc0-4b9b-b785-31f1f14f18b8';
const gitRemote = 'https://github.com/acme/formation.git';

function loadGitRemote() {
  const javascript = ts.transpileModule(gitRemoteSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, URL });
  return module.exports;
}

function loadProjects(query) {
  const calls = [];
  const connection = {
    async query(sql, values = []) { calls.push({ sql, values }); return query(sql, values); },
    release() { calls.push({ sql: 'release', values: [] }); },
  };
  const pool = { async connect() { calls.push({ sql: 'connect', values: [] }); return connection; } };
  const javascript = ts.transpileModule(projectSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module, exports: module.exports, Buffer, console,
    require(specifier) {
      if (specifier === 'node:crypto') return crypto;
      if (specifier === './db') return { ensureSchema: async () => {}, getPool: () => pool };
      if (specifier === './project-agent-documents') return { async loadProjectAgentStructuredData() { return { memberRoster: [], projectStatistics: {} }; }, async ensureCanonicalProjectDocuments() {} };
      if (specifier === './git-remote') return loadGitRemote();
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  return { service: module.exports, calls };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('client formation atomically creates active creator memberships for every selected approved engineer', async () => {
  const project = { id: '77', client_id: '10', title: 'Formation', description: 'Together', status: 'open', creation_payload_fingerprint: '' };
  const members = [
    { id: '101', project_id: '77', user_id: '2', membership_type: 'creator', membership_status: 'active', created_by: '10' },
    { id: '102', project_id: '77', user_id: '10', membership_type: 'creator', membership_status: 'active', created_by: '10' },
  ];
  let fingerprint = '';
  const { service, calls } = loadProjects(async (sql, values) => {
    if (/^(begin|commit)$/i.test(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) {
      assert.match(sql, /creation_payload_fingerprint/i);
      fingerprint = values[6];
      assert.match(fingerprint, /^[a-f0-9]{64}$/);
      project.creation_payload_fingerprint = fingerprint;
      return { rows: [project] };
    }
    if (/insert into project_memberships/i.test(sql)) {
      assert.match(sql, /account_type='engineer'[\s\S]*approval_status='approved'/i);
      assert.match(sql, /'creator','active'/i);
      assert.deepEqual(plain(values.slice(0, 3)), ['77', ['2', '10'], '10']);
      return { rows: members };
    }
    if (/from projects p/i.test(sql) && /creation_request_key/i.test(sql)) return { rows: [project] };
    if (/from project_memberships/i.test(sql) && /user_id=any/i) return { rows: members };
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await service.createProject(client, { title: ' Formation ', description: ' Together ', status: 'open', engineerIds: ['10', '2'], requestKey, gitRemote });
  assert.deepEqual(plain(result.memberships), members);
  assert.equal(calls.filter(({ sql }) => /^commit$/i.test(sql)).length, 1);
  assert.equal(calls.filter(({ sql }) => /^rollback$/i.test(sql)).length, 0);
});

test('malformed, duplicate, or excessive engineer selections fail before database access', async () => {
  const { service, calls } = loadProjects(async () => { throw new Error('database must not be reached'); });
  const invalidSelections = [
    '20',
    ['0'],
    ['20', '20'],
    Array.from({ length: 21 }, (_, index) => String(index + 1)),
  ];
  for (const engineerIds of invalidSelections) {
    await assert.rejects(
      service.createProject(client, { title: 'Formation', engineerIds, requestKey, gitRemote }),
      (error) => error?.status === 400 && error?.code === 'invalid_request',
    );
  }
  assert.equal(calls.length, 0);
});

test('one invalid or unapproved selected engineer rolls back the whole client formation', async () => {
  const project = { id: '77', creation_payload_fingerprint: 'a'.repeat(64) };
  const { service, calls } = loadProjects(async (sql) => {
    if (/^begin$|^rollback$/i.test(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) return { rows: [project] };
    if (/insert into project_memberships/i.test(sql)) return { rows: [{ user_id: '20' }] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  await assert.rejects(
    service.createProject(client, { title: 'Formation', engineerIds: ['20', '404'], requestKey, gitRemote }),
    (error) => error?.status === 409 && error?.code === 'conflict',
  );
  assert.equal(calls.filter(({ sql }) => /^rollback$/i.test(sql)).length, 1);
  assert.equal(calls.filter(({ sql }) => /^commit$/i.test(sql)).length, 0);
});

test('same request key rejects a materially different payload and exact replay returns canonical creators', async () => {
  const members = [{ id: '101', project_id: '77', user_id: '20', membership_type: 'creator', membership_status: 'active', created_by: '10' }];
  let storedFingerprint = '';
  let attempts = 0;
  const { service } = loadProjects(async (sql, values) => {
    if (/^begin$|^commit$|^rollback$/i.test(sql)) return { rows: [] };
    if (/insert into projects/i.test(sql)) {
      attempts += 1;
      if (!storedFingerprint) storedFingerprint = values[6];
      return { rows: attempts === 1 ? [{ id: '77', creation_payload_fingerprint: storedFingerprint }] : [] };
    }
    if (/insert into project_memberships/i.test(sql)) return { rows: members };
    if (/from projects p/i.test(sql) && /creation_request_key/i.test(sql)) return { rows: [{ id: '77', creation_payload_fingerprint: storedFingerprint }] };
    if (/from project_memberships/i.test(sql) && /user_id=any/i) return { rows: members };
    throw new Error(`Unexpected query: ${sql}`);
  });

  const exact = { title: 'Formation', status: 'open', engineerIds: ['20'], requestKey, gitRemote };
  assert.deepEqual(plain((await service.createProject(client, exact)).memberships), members);
  assert.deepEqual(plain((await service.createProject(client, exact)).memberships), members);
  await assert.rejects(
    service.createProject(client, { ...exact, title: 'Different' }),
    (error) => error?.status === 409 && error?.code === 'conflict',
  );
});

test('client creation UI truthfully selects co-creators and scopes idempotency keys to a stable payload fingerprint', () => {
  assert.match(clientSource, /selectedEngineerIds/);
  assert.match(clientSource, /type="checkbox"/);
  assert.match(clientSource, /engineerIds:\s*sortedEngineerIds/);
  assert.match(clientSource, /createRequestFingerprintRef/);
  assert.match(clientSource, /JSON\.stringify/);
  assert.match(clientSource, /fingerprint[\s\S]*crypto\.randomUUID\(\)/);
  assert.match(clientSource, /sort\(\)/, 'selection order must not change the request identity');
  assert.match(clientSource, /Add engineers/i);
  assert.match(clientSource, /join immediately as project creators/i);
});
