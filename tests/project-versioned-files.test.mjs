import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const required = [
  'migrations/008_project_agent_files.sql',
  'lib/project-files.ts',
  'app/api/projects/[projectId]/files/route.ts',
  'app/api/projects/[projectId]/files/[fileId]/route.ts',
];

test('versioned project-file schema and authorized routes exist', () => {
  for (const path of required) assert.ok(existsSync(new URL(path, root)), `${path} must exist`);
  const migration = read(required[0]);
  const db = read('lib/db.ts');
  for (const source of [migration, db]) {
    assert.match(source, /create table if not exists project_files/i);
    assert.match(source, /create table if not exists project_file_heads/i);
    assert.match(source, /unique index[\s\S]*project_file_heads[\s\S]*\(project_id\s*,\s*path\)[\s\S]*deleted_at is null/i);
    assert.doesNotMatch(source, /unique\s*\(project_id\s*,\s*path\s*,\s*version\s*\)/i);
    assert.match(source, /unique\s*\(project_id\s*,\s*file_id\s*,\s*version\s*\)/i);
    assert.match(source, /octet_length\(content\)\s*<=\s*262144/i);
    assert.match(source, /path[^\n]*!~[^\n]*\\\\/i, 'database must reject backslashes');
  }
  const listRoute = read(required[2]);
  const downloadRoute = read(required[3]);
  for (const route of [listRoute, downloadRoute]) {
    assert.match(route, /requireApiSession/);
    assert.match(route, /cache-control[^\n]*no-store/i);
    assert.doesNotMatch(route, /storage[_K]ey|readFile|createReadStream/);
  }
  assert.match(downloadRoute, /content-disposition/i);
});

function loadFiles(query) {
  const source = read('lib/project-files.ts');
  const calls = [];
  const pool = { async query(sql, values = []) { calls.push({ sql, values }); return query(sql, values); } };
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module, exports: module.exports, Buffer,
    require(specifier) {
      if (specifier === './db') return { ensureSchema: async () => {}, getPool: () => pool };
      if (specifier === './projects') return {
        ProjectServiceError: class ProjectServiceError extends Error { constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; } },
        projectAccessSql(user, project = 'p', membership = 'access_membership') { return { join: `left join project_memberships ${membership} on ${membership}.project_id=${project}.id and ${membership}.user_id=${user}`, predicate: `(${project}.client_id=${user} or ${membership}.user_id=${user})` }; },
      };
      throw new Error(`Unexpected import: ${specifier}`);
    },
  });
  return { service: module.exports, calls };
}

test('safe relative path validator rejects traversal, absolute, reserved segments, controls, and oversized text', () => {
  const { service } = loadFiles(async () => ({ rows: [] }));
  for (const path of ['', '/etc/passwd', '../secret', 'a/../b', 'a//b', 'a\\b', 'a/./b', 'a\0b']) {
    assert.throws(() => service.validateProjectFilePath(path), /path/i, path);
  }
  assert.equal(service.validateProjectFilePath('src/report.txt'), 'src/report.txt');
  assert.throws(() => service.validateProjectFileContent('x'.repeat(262145)), /256KB/i);
});

test('listing and download resolve one exact latest non-tombstone version with centralized project access', async () => {
  const latest = { file_id: '12345678-1234-4234-8234-123456789abc', version: 3, path: 'docs/a.txt', media_type: 'text/plain', content: 'latest', byte_size: 6, sha256: 'a'.repeat(64), created_at: 'now' };
  const { service, calls } = loadFiles(async (sql) => {
    if (/select 1 from projects/i.test(sql)) return { rows: [{ '?column?': 1 }] };
    if (/from project_file_heads/i.test(sql)) return { rows: [latest] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const session = { id: '9', account_type: 'engineer', role: 'user' };
  const listed = await service.listProjectFiles(session, '2');
  assert.equal(listed[0].content, undefined, 'manifest must not leak content');
  assert.equal(listed[0].version, 3);
  const downloaded = await service.getProjectFile(session, '2', latest.file_id);
  assert.equal(downloaded.content, 'latest');
  assert.ok(calls.every((call) => !/storage_key/i.test(call.sql)));
  assert.ok(calls.some((call) => /projectAccessSql|project_memberships/i.test(call.sql)));
  assert.ok(calls.filter((call) => /from project_file_heads/i.test(call.sql)).every((call) => /current_version/i.test(call.sql)));
});

test('project agent exposes only file actions, auto-confirms create, and versions mutations', () => {
  const source = read('lib/project-chat.ts');
  assert.match(source, /ACTION_TYPES\s*=\s*\[['"]create_file['"],\s*['"]update_file['"],\s*['"]rename_file['"],\s*['"]delete_file['"]\]/);
  assert.doesNotMatch(source, /case ['"](?:create_record|update_record|register_artifact|delete_record)['"]/);
  assert.match(source, /create_file[\s\S]*status[^\n]*confirmed/i);
  assert.match(source, /update_file[\s\S]*expectedVersion[\s\S]*insert into project_files/i);
  assert.match(source, /rename_file[\s\S]*expectedVersion[\s\S]*insert into project_files/i);
  assert.match(source, /delete_file[\s\S]*expectedVersion[\s\S]*insert into project_files/i);
  assert.match(source, /project_file_heads[\s\S]*current_version/i);
  assert.match(source, /hiddenProjectState|hidden project state/i);
  assert.doesNotMatch(source, /storageKey|child_process|execSync|spawn\(/);
});
