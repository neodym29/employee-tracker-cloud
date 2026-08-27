import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

function loadChat() {
  const javascript = ts.transpileModule(read('lib/project-chat.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module, exports: module.exports, Buffer, URL, AbortController, AbortSignal, TextDecoder, ReadableStream,
    fetch: globalThis.fetch, process: { env: {} },
    require(specifier) {
      if (specifier === 'node:crypto') return crypto;
      if (specifier === './db') return { ensureSchema: async () => {}, getPool: () => ({}) };
      if (specifier === './project-files') return { PROJECT_FILE_TOMBSTONE_MEDIA_TYPE: 'application/x.project-tombstone', validateProjectFileContent: (v) => v, validateProjectFileMediaType: (v) => v, validateProjectFilePath: (v) => v };
      if (specifier === './project-agent-documents') return { async loadProjectAgentStructuredData() { return { memberRoster: [], projectStatistics: {} }; }, async ensureCanonicalProjectDocuments() {} };
      if (specifier === './projects') return { ProjectServiceError: class extends Error { constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; } }, projectAccessSql: () => ({ join: '', predicate: 'true' }) };
      throw new Error(`unexpected import ${specifier}`);
    },
  });
  return module.exports;
}

function stateClient() {
  const heads = new Map();
  const versions = [];
  return { heads, versions, async query(sql, values = []) {
    if (/pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
    if (/select file_id from project_file_heads/i.test(sql)) {
      const [project, path, except] = values;
      return { rows: [...heads.values()].filter((h) => h.project_id === project && h.path === path && !h.deleted_at && (!except || h.file_id !== except)).slice(0, 1) };
    }
    if (/from project_file_heads h[\s\S]*for update/i.test(sql)) {
      const [project, file] = values;
      const h = heads.get(`${project}:${file}`);
      if (!h) return { rows: [] };
      const v = versions.find((row) => row.project_id === project && row.file_id === file && row.version === h.current_version);
      return { rows: [{ ...h, version: h.current_version, content: v.content }] };
    }
    if (/insert into project_files/i.test(sql)) {
      const [project_id, file_id, version, path, media_type, content, byte_size, sha256] = values;
      const row = { project_id, file_id, version, path, media_type, content, byte_size, sha256, created_at: 'now' };
      versions.push(row); return { rows: [row] };
    }
    if (/insert into project_file_heads/i.test(sql)) {
      const [project_id, file_id, current_version, path, media_type, byte_size, sha256] = values;
      const row = { project_id, file_id, current_version, path, media_type, byte_size, sha256, deleted_at: null };
      heads.set(`${project_id}:${file_id}`, row); return { rows: [row] };
    }
    if (/update project_file_heads/i.test(sql)) {
      const [project, file, current_version, path, media_type, byte_size, sha256, deleted] = values;
      const row = heads.get(`${project}:${file}`);
      Object.assign(row, { current_version, path, media_type, byte_size, sha256, deleted_at: deleted ? 'now' : null });
      return { rows: [row] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  } };
}

test('actual action state machine allows rename/path reuse and delete/recreate while retaining identity history', async () => {
  const { executeFileAction } = loadChat();
  const db = stateClient();
  const session = { id: '9' };
  const first = await executeFileAction(db, '2', session, 'create_file', { path: 'a.txt', mediaType: 'text/plain', content: 'one' });
  await executeFileAction(db, '2', session, 'rename_file', { fileId: first.fileId, expectedVersion: 1, path: 'b.txt' });
  const reused = await executeFileAction(db, '2', session, 'create_file', { path: 'a.txt', mediaType: 'text/plain', content: 'new identity' });
  assert.notEqual(reused.fileId, first.fileId);
  await executeFileAction(db, '2', session, 'delete_file', { fileId: first.fileId, expectedVersion: 2 });
  const recreated = await executeFileAction(db, '2', session, 'create_file', { path: 'b.txt', mediaType: 'text/plain', content: 'again' });
  assert.notEqual(recreated.fileId, first.fileId);
  assert.equal(db.versions.filter((v) => v.file_id === first.fileId).length, 3);
});

test('locked stable head makes stale expectedVersion conflicts deterministic 409', async () => {
  const { executeFileAction } = loadChat();
  const db = stateClient();
  const session = { id: '9' };
  const file = await executeFileAction(db, '2', session, 'create_file', { path: 'a.txt', mediaType: 'text/plain', content: 'one' });
  await executeFileAction(db, '2', session, 'update_file', { fileId: file.fileId, expectedVersion: 1, content: 'two' });
  await assert.rejects(executeFileAction(db, '2', session, 'update_file', { fileId: file.fileId, expectedVersion: 1, content: 'stale' }), (error) => error.status === 409 && error.code === 'version_conflict');
});

test('version rows are trigger-protected and audit transition is immutable, complete, and actor-bound', () => {
  for (const sql of [read('migrations/008_project_agent_files.sql'), read('lib/db.ts')]) {
    assert.match(sql, /before update or delete on project_files/i);
    assert.match(sql, /project file version rows are immutable/i);
    assert.match(sql, /project_agent_actions_actor_not_null[\s\S]*not valid/i);
    assert.match(sql, /new\.id\s*=\s*old\.id/i);
    assert.match(sql, /new\.confirmed_by\s*=\s*old\.actor_user_id/i);
    assert.match(sql, /new\.result is not null/i);
    assert.match(sql, /new\.output is not distinct from old\.output/i);
    assert.match(sql, /project_files_project_id_fkey[\s\S]*on delete restrict/i);
    assert.match(sql, /project_agent_actions_project_id_fkey[\s\S]*on delete restrict/i);
  }
});

test('backend request budgeting counts complete escaped UTF-8 JSON deterministically below bridge body limit', () => {
  const { buildBoundedBackendMessages, backendRequestBytes, MAX_BACKEND_REQUEST_BYTES } = loadChat();
  const files = Array.from({ length: 50 }, (_, i) => ({ file_id: `${i}`.padStart(36, '0'), version: 1, path: `weird-${i}-\"-😀.txt`, media_type: 'text/plain', content: '\\"😀'.repeat(90000), byte_size: 1, sha256: 'a'.repeat(64) }));
  const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', body: '\"😀'.repeat(8000) }));
  const args = [{ id: '2', title: '😀'.repeat(1000), description: '\\"'.repeat(5000), status: 'active' }, files, history, 'latest 😀 request'];
  const one = buildBoundedBackendMessages(...args);
  const two = buildBoundedBackendMessages(...args);
  assert.equal(JSON.stringify(one), JSON.stringify(two));
  assert.ok(backendRequestBytes(one) <= MAX_BACKEND_REQUEST_BYTES);
  assert.ok(MAX_BACKEND_REQUEST_BYTES < 1024 * 1024);
  assert.equal(one.at(-1).content, 'latest 😀 request');
});

test('backend response reader aborts immediately on chunked oversized output', async () => {
  const { readBoundedResponse, MAX_BACKEND_BYTES } = loadChat();
  let cancelled = false;
  const chunk = new Uint8Array(64 * 1024);
  const body = new ReadableStream({ pull(controller) { controller.enqueue(chunk); }, cancel() { cancelled = true; } });
  const controller = new AbortController();
  await assert.rejects(readBoundedResponse({ body }, controller, MAX_BACKEND_BYTES), (error) => error.status === 502);
  assert.equal(controller.signal.aborted, true);
  assert.equal(cancelled, true);
});

test('RFC5987 disposition encodes Unicode, quotes, parentheses, asterisk and controls', () => {
  const javascript = ts.transpileModule(read('lib/project-files.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, Buffer, require: (s) => s === './db' ? {} : { ProjectServiceError: Error } });
  const value = module.exports.projectFileContentDisposition('docs/quo\"te (x)* 😀\u0001.txt');
  assert.match(value, /^attachment; filename="[^"\u0000-\u001f\u007f]*"; filename\*=UTF-8''/);
  assert.match(value, /%22/);
  assert.match(value, /%28x%29%2A/);
  assert.match(value, /%F0%9F%98%80/);
  assert.match(value, /%01/);
});
