import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const { Client, Pool } = pg;
const requireFromTest = createRequire(import.meta.url);
const migration = readFileSync(new URL('../migrations/020_tracemini_project_discovery.sql', import.meta.url), 'utf8');

function loadDiscovery(pool) {
  const source = readFileSync(new URL('../lib/tracemini-discovery.ts', import.meta.url), 'utf8');
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const projectError = class ProjectServiceError extends Error {
    constructor(message, status, code) { super(message); this.status = status; this.code = code; }
  };
  const localRequire = (name) => {
    if (name === 'server-only') return {};
    if (name === './db') return { ensureSchema: async () => {}, getPool: () => pool };
    if (name === './auth') return {};
    if (name === './projects') return { ProjectServiceError: projectError };
    return requireFromTest(name);
  };
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, require: localRequire, process, Buffer,
    console, setTimeout, clearTimeout, URL, URLSearchParams,
  };
  vm.runInNewContext(javascript, context);
  return { api: { ...context.module.exports, ...context.exports }, ProjectServiceError: projectError };
}

async function postgres(t) {
  let container;
  try {
    container = execFileSync('docker', ['run', '-d', '--rm', '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=test', '-P', 'postgres:16-alpine'], { encoding: 'utf8' }).trim();
  } catch (error) {
    t.skip(`Docker unavailable: ${error.message}`);
    return null;
  }
  t.after(() => { try { execFileSync('docker', ['rm', '-f', container]); } catch {} });
  let port;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').pop();
      const probe = new Client({ host: '127.0.0.1', port: Number(port), user: 'postgres', password: 'test', database: 'test' });
      await probe.connect(); await probe.end(); break;
    } catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  assert.ok(port, 'Postgres container did not become ready');
  const pool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', password: 'test', database: 'test', max: 4 });
  await pool.query(`
    create table companies(id bigint primary key);
    create table app_users(id bigint primary key, company_id bigint not null references companies(id), role text default 'employee', approval_status text default 'approved');
    create table files_agent_devices(id bigint primary key, company_id bigint not null references companies(id), user_id bigint not null references app_users(id), credential_hash text not null, revoked_at timestamptz);
    create table projects(id bigint primary key, client_id bigint not null references app_users(id), approval_status text not null default 'approved', git_repository_key text, company_id bigint not null references companies(id));
    create table project_tracemini_roots(id bigserial primary key,project_id bigint,device_id bigint,binding_id text,binding_secret_hash text,root_hash text,root_label text,repository_key text,status text,approved_by bigint,approved_at timestamptz,last_heartbeat_at timestamptz,revoked_at timestamptz,unique(project_id,device_id,root_hash));
    create table project_memberships(id bigint primary key, project_id bigint references projects(id), user_id bigint references app_users(id), membership_status text not null default 'active');
    insert into companies values (1), (2);
    insert into app_users(id,company_id,role) values (11,1,'employee'), (12,1,'employee'), (21,2,'employee');
    insert into files_agent_devices values (101,1,11,'${crypto.createHash('sha256').update('device-one').digest('hex')}',null), (102,1,12,'${crypto.createHash('sha256').update('device-two').digest('hex')}',null), (201,2,21,'${crypto.createHash('sha256').update('device-other').digest('hex')}',null);
    insert into projects values (1001,11,'approved','github.com/acme/widget',1), (1002,12,'approved','github.com/acme/widget',1);
    insert into project_memberships values (1,1001,12,'active'), (2,1002,11,'active');
  `);
  await pool.query('alter table files_agent_devices add column last_seen_at timestamptz');
  await pool.query(migration);
  return { pool, ...loadDiscovery(pool), sessionOne: { id: '11', company_id: '1', role: 'employee' }, sessionTwo: { id: '12', company_id: '1', role: 'employee' } };
}

test('device work polling is executable, credential failures are 401, and UNION rows are shaped', async (t) => {
  const ctx = await postgres(t); if (!ctx) return;
  const { pool, api } = ctx;
  try {
    await assert.rejects(api.claimDeviceWork('wrong-secret'), (error) => error.status === 401);
    const scan = await api.createRepositoryScan(ctx.sessionOne, '101');
    await pool.query(`update tracemini_scan_requests set state='running', claimed_at=null where id=$1`, [scan.requestId]);
    const result = await api.claimDeviceWork('device-one');
    assert.equal(result.work[0].kind, 'scan');
    assert.ok(Object.hasOwn(result.work[0], 'work_id'));
  } finally { await pool.end(); }
});

test('publication enforces scan ownership, refreshes conflicts, bounds fingerprints, and matches approved owner/member projects', async (t) => {
  const ctx = await postgres(t); if (!ctx) return;
  const { pool, api } = ctx;
  try {
    const scan = await api.createRepositoryScan(ctx.sessionOne, '101');
    const scanWork = (await api.claimDeviceWork('device-one')).work.find((item) => item.kind === 'scan');
    assert.equal(scanWork.work_id, scan.requestId);
    assert.ok(scanWork.claim_token);
    await assert.rejects(api.publishRepositoryCandidates('device-two', { scan_id: scan.requestId, claim_token: scanWork.claim_token, repositories: [] }), (error) => error.status === 409);
    await assert.rejects(api.publishRepositoryCandidates('device-one', { scan_id: scan.requestId, repositories: [] }), (error) => error.status === 400 && error.message === 'claim_token is required');
    for (const fingerprint of [{ device_id: 'x'.repeat(161) }, { inode: Number.MAX_SAFE_INTEGER + 1 }, { inode: -1 }, { inode: 1, path: '/private' }]) {
      await assert.rejects(api.publishRepositoryCandidates('device-one', {
        scan_id: scan.requestId, claim_token: scanWork.claim_token,
        repositories: [{ display_name: 'invalid', repository_key: 'github.com/acme/widget', fingerprint }],
      }), (error) => error.status === 400);
    }
    await api.publishRepositoryCandidates('device-one', { scan_id: scan.requestId, claim_token: scanWork.claim_token, repositories: [{ display_name: 'widget', repository_key: 'github.com/acme/widget', branch: 'main', head_sha: 'a'.repeat(40), fingerprint: { device_id: 'dev-a', inode: 1, birthtime_ns: 2 } }] });
    await api.publishRepositoryCandidates('device-one', { scan_id: scan.requestId, claim_token: scanWork.claim_token, repositories: [{ display_name: 'widget-renamed', repository_key: 'github.com/acme/widget', branch: 'develop', head_sha: 'b'.repeat(40), fingerprint: { device_id: 'dev-a', inode: 1, birthtime_ns: 2 } }] });
    const row = await pool.query(`select * from tracemini_repository_candidates where device_id=101`);
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].display_name, 'widget-renamed');
    assert.equal(row.rows[0].branch, 'develop');
    assert.equal(row.rows[0].matched_project_id, null);
    assert.equal(row.rows[0].match_status, 'ambiguous');
    assert.deepEqual(row.rows[0].fingerprint, { device_id: 'dev-a', inode: 1, birthtime_ns: 2 });
  } finally { await pool.end(); }
});

test('revision races, stale completion, tenant isolation, and exact push identity are rejected', async (t) => {
  const ctx = await postgres(t); if (!ctx) return;
  const { pool, api } = ctx;
  const previous = process.env.FILES_AGENT_BINDING_KEY;
  process.env.FILES_AGENT_BINDING_KEY = 'test-only-discovery-binding-key-'.repeat(2);
  t.after(() => { if (previous === undefined) delete process.env.FILES_AGENT_BINDING_KEY; else process.env.FILES_AGENT_BINDING_KEY = previous; });
  try {
    await pool.query(`update projects set approval_status='rejected' where id=1002`);
    const scan = await api.createRepositoryScan(ctx.sessionOne, '101');
    const scanWork = (await api.claimDeviceWork('device-one')).work.find((item) => item.kind === 'scan');
    assert.equal(scanWork.work_id, scan.requestId);
    assert.ok(scanWork.claim_token);
    await api.publishRepositoryCandidates('device-one', { scan_id: scan.requestId, claim_token: scanWork.claim_token, repositories: [{ display_name: 'widget', repository_key: 'github.com/acme/widget', fingerprint: { device_id: 'dev-a', inode: 2, birthtime_ns: 3 } }] });
    const candidate = (await pool.query(`select id,revision from tracemini_repository_candidates limit 1`)).rows[0];
    const match = (await pool.query(`select matched_project_id,match_status from tracemini_repository_candidates where id=$1`, [candidate.id])).rows[0];
    assert.equal(match.matched_project_id, '1001');
    assert.equal(match.match_status, 'matched', 'unapproved projects do not make the match ambiguous');
    const selected = await api.selectRepositoryCandidate(ctx.sessionOne, candidate.id, true, candidate.revision);
    await assert.rejects(api.selectRepositoryCandidate(ctx.sessionOne, candidate.id, false, candidate.revision), (error) => error.status === 409);
    const work = await api.claimDeviceWork('device-one');
    const selectionWork = work.work.find((item) => item.kind === 'selection');
    assert.equal(work.work.some((item) => item.kind === 'scan'), false, 'an active scan lease is not claimed twice');
    await assert.rejects(api.completeDeviceWork('device-one', { kind: 'selection', work_id: candidate.id, claim_token: selectionWork.claim_token, revision: selected.revision - 1, tracked: true }), (error) => error.status === 409);
    await assert.rejects(api.completeDeviceWork('device-one', { kind: 'scan', work_id: scan.requestId, claim_token: `${scanWork.claim_token}stale`, count: 1 }), (error) => error.status === 409);
    await assert.rejects(api.repositoryScanStatus(ctx.sessionTwo, scan.requestId), (error) => error.status === 404);
    await assert.rejects(api.createPendingPush('device-one', { repository_key: 'https://github.com/acme/widget', branch: 'main', expected_head_sha: 'c'.repeat(40) }), (error) => error.status === 400);
  } finally { await pool.end(); }
});
