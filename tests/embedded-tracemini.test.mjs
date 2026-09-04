import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const localRequire = createRequire(import.meta.url);
function load(path) {
  const javascript = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, require: localRequire, Buffer, process });
  return module.exports;
}

test('embedded validation is local-only and rejects unsafe context', () => {
  const mod = load('lib/embedded-tracemini.ts');
  assert.deepEqual(mod.progressFromEvents([{ kind: 'commit' }]), null);
  assert.throws(() => mod.validateOptionalContext({ diff: 'x' }), /consent/);
  assert.throws(() => mod.validateOptionalContext({ diff: 'x'.repeat(10001), consent: true }), /bounded/);
  assert.throws(() => mod.validateOptionalContext({ token: 'secret' }), /environment/);
});

test('migration and runtime schema expose matching executable upgrade primitives', () => {
  const migration = read('migrations/019_embedded_tracemini.sql');
  const runtime = read('lib/db.ts');
  for (const name of ['project_tracemini_binding_codes','project_tracemini_roots','project_tracemini_events','project_tracemini_reports','project_tracemini_schedules','tracemini_request_nonces']) {
    assert.ok(migration.includes(name) && runtime.includes(name), name);
  }
  assert.ok(migration.includes('before update or delete on project_tracemini_evidence'));
  assert.ok(runtime.includes('before update or delete on project_tracemini_evidence'));
});

test('root attribution fails closed and selects the longest approved root', () => {
  const mod = load('lib/embedded-tracemini.ts');
  const roots = [{ projectId: '1', deviceId: '2', rootHash: 'a'.repeat(64), rootPath: '/srv/work' }, { projectId: '2', deviceId: '3', rootHash: 'b'.repeat(64), rootPath: '/srv/work/repo' }];
  assert.equal(mod.selectProjectForPath('/srv/work/repo/src', roots).projectId, '2');
  assert.throws(() => mod.selectProjectForPath('/tmp/other', roots), /no approved/);
  assert.throws(() => mod.selectProjectForPath('/srv/work/repo', roots, '9'), /not authoritative/);
});
