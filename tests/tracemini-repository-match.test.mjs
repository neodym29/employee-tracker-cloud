import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const root = new URL('../', import.meta.url);
const source = (p) => readFileSync(new URL(p, root), 'utf8');
function load(p, stubs = {}) { assert.ok(existsSync(new URL(p, root))); const js = ts.transpileModule(source(p), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText; const module = { exports: {} }; vm.runInNewContext(js, { module, exports: module.exports, URL, require(s) { if (s in stubs) return stubs[s]; throw new Error(`Unexpected ${s}`); } }); return module.exports; }
const git = load('lib/git-remote.ts');

test('matches only exactly one canonical repository and scopes events to repository id', () => {
  const mod = load('lib/tracemini-normalize.ts', { './git-remote': git });
  const input = { dashboard: { repositories: [
    { id: 'repo-1', name: 'widget', normalized_remote: 'git@github.com:Acme/widget.git' },
    { id: 'repo-2', name: 'widget-docs', normalized_remote: 'https://github.com/Acme/widget-docs.git' },
  ], events: [
    { id: 'e1', repository_id: 'repo-1', type: 'commit', occurred_at: '2026-01-01T00:00:00Z', user_name: 'a@example.com', data: {} },
    { id: 'e2', repository_id: 'repo-2', type: 'commit', occurred_at: '2026-01-01T00:00:01Z', data: {} },
  ], stats: {}, timeline: [] }, settings: { local_clones: [{ repository_id: 'repo-1', path: '/home/alice/secret', upstream_remote: 'https://token@github.com/Acme/widget' }] }, agents: [], reports: [] };
  const out = mod.normalizeTraceMiniData(input, [], 'github.com/Acme/widget');
  assert.equal(out.matchStatus, 'matched');
  assert.equal(out.matchedRepository.name, 'widget');
  assert.equal(out.recentActivity.length, 1);
  assert.equal(out.recentActivity[0].repositoryId, 'repo-1');
  assert.equal(out.hasLocalClone, true);
  assert.equal(out.localCloneCount, 1);
  const serialized = JSON.stringify(out);
  for (const secret of ['/home/alice', 'upstream_remote', 'token@', 'normalized_remote']) assert.equal(serialized.includes(secret), false, secret);
});

test('zero and duplicate exact matches fail closed without name or substring guessing', () => {
  const mod = load('lib/tracemini-normalize.ts', { './git-remote': git });
  const base = { events: [], stats: {}, timeline: [] };
  let out = mod.normalizeTraceMiniData({ dashboard: { ...base, repositories: [{ id: '1', name: 'widget', normalized_remote: 'https://github.com/acme/other' }] }, settings: {}, agents: [], reports: [] }, [], 'github.com/acme/widget');
  assert.equal(out.matchStatus, 'unmatched');
  assert.equal(out.recentActivity.length, 0);
  assert.equal(out.repositories.length, 0);
  assert.equal(out.devices.length, 0);
  assert.equal(out.memberActivity.length, 0);
  assert.equal(out.localCloneCount, 0);
  out = mod.normalizeTraceMiniData({ dashboard: { ...base, repositories: [{ id: '1', name: 'one', normalized_remote: 'https://github.com/acme/widget' }, { id: '2', name: 'two', normalized_remote: 'git@github.com:acme/widget.git' }] }, settings: {}, agents: [], reports: [] }, [], 'github.com/acme/widget');
  assert.equal(out.matchStatus, 'ambiguous');
  assert.equal(out.recentActivity.length, 0);
  assert.equal(out.repositories.length, 0);
});

test('null link exposes fail-closed match status and empty scoped collections', () => {
  const mod = load('lib/tracemini-normalize.ts', { './git-remote': git });
  const out = mod.normalizeTraceMiniData({ dashboard: { events: [{ id: 'e', repository_id: 'r', type: 'commit', occurred_at: '2026-01-01' }], repositories: [{ id: 'r', name: 'private', normalized_remote: 'https://github.com/acme/private.git' }], stats: {}, timeline: [] }, settings: { clones: [{ repository_id: 'r' }] }, agents: [{ repository_id: 'r', status: 'online' }], reports: [{ repository_id: 'r' }] }, [], null);
  assert.equal(out.matchStatus, 'unmatched');
  for (const key of ['recentActivity', 'repositories', 'devices', 'memberActivity', 'reports']) assert.equal(out[key].length, 0, key);
  assert.equal(out.activityTotal, 0);
  assert.equal(out.localCloneCount, 0);
  assert.equal(out.hasLocalClone, false);
});

test('matched DTO includes only exact-repository settings, agents and reports', () => {
  const mod = load('lib/tracemini-normalize.ts', { './git-remote': git });
  const dashboard = { events: [], repositories: [{ id: 'r1', name: 'one', normalized_remote: 'https://github.com/acme/one.git' }, { id: 'r2', name: 'two', normalized_remote: 'https://github.com/acme/two.git' }], stats: {}, timeline: [] };
  const out = mod.normalizeTraceMiniData({ dashboard, settings: { clones: [{ repository_id: 'r1' }, { repository_id: 'r2' }, {}] }, agents: [{ repository_id: 'r1', status: 'online' }, { repository_id: 'r2', status: 'online' }, { status: 'online' }], reports: [{ repository_id: 'r1', status: 'complete' }, { repository_id: 'r2' }, {}] }, [], 'github.com/acme/one');
  assert.equal(out.repositories.length, 1);
  assert.equal(out.repositories[0].id, 'r1');
  assert.equal(out.localCloneCount, 1);
  assert.equal(out.devices.length, 1);
  assert.equal(out.reports.length, 1);
});

test('repository names are safely truncated to the database schema limit', () => {
  const mod = load('lib/tracemini-normalize.ts', { './git-remote': git });
  const name = 'a'.repeat(200);
  const dashboard = { events: [], repositories: [{ id: 'r1', name, normalized_remote: 'https://github.com/acme/one.git' }], stats: {}, timeline: [] };
  const out = mod.normalizeTraceMiniData({ dashboard }, [], 'github.com/acme/one');
  assert.equal(out.matchStatus, 'matched');
  assert.equal(out.matchedRepository.name.length, 160);
  assert.equal(out.repositories[0].name.length, 160);
});

test('adapter exposes only confirmed five GET endpoints', () => {
  const adapter = source('lib/tracemini-adapter.ts');
  for (const path of ['/api/bootstrap', '/dashboard', '/settings', '/agents', '/reports']) assert.match(adapter, new RegExp(path.replaceAll('/', '\\/')));
  for (const removed of ["workspaces: () => '/api/workspaces'", '/activity', '/repositories']) assert.equal(adapter.includes(removed), false, removed);
  assert.match(adapter, /authorization:\s*`Bearer \$\{userSession\}`/);
  const service = source('lib/tracemini.ts');
  assert.match(service, /dashboard\.events/);
  assert.match(service, /dashboard\.repositories/);
});
