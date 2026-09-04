import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
function load(path) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require, Buffer, process });
  return module.exports;
}

test('progress is never inferred from embedded events', () => {
  assert.equal(load('lib/embedded-tracemini.ts').progressFromEvents([{ kind: 'commit' }, { kind: 'dirty' }]), null);
});

test('only an exact owner confirmation can create factual evidence', () => {
  const { canCreateEvidence } = load('lib/embedded-tracemini.ts');
  assert.equal(canCreateEvidence({ actorId: 'owner', ownerId: 'owner', confirmed: true }), true);
  assert.equal(canCreateEvidence({ actorId: 'engineer', ownerId: 'owner', confirmed: true }), false);
  assert.equal(canCreateEvidence({ actorId: 'owner', ownerId: 'owner', confirmed: false }), false);
});
