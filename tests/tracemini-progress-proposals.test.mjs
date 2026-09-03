import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const crypto = await import('node:crypto');
const root = new URL('../', import.meta.url);
const source = (p) => readFileSync(new URL(p, root), 'utf8');
function load(p, dependencies = {}) { assert.ok(existsSync(new URL(p, root)), `${p} must exist`); const js = ts.transpileModule(source(p), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText; const module = { exports: {} }; vm.runInNewContext(js, { module, exports: module.exports, Buffer, URL, require(s) { if (s === 'node:crypto') return crypto; if (Object.hasOwn(dependencies, s)) return dependencies[s]; throw new Error(s); } }); return module.exports; }

test('progress policy uses exact safe floors and Cloud-generated bounded summary', () => {
  const mod = load('lib/tracemini-progress.ts');
  const current = { percent: 10, summary: 'Started', version: 3 };
  const events = [
    { id: 'ui-1', upstreamId: '1', repositoryId: 'r1', type: 'git.clone', occurredAt: '2026-01-01T00:00:00Z', data: {} },
    { id: 'ui-2', upstreamId: '2', repositoryId: 'r1', type: 'commit', occurredAt: '2026-01-02T00:00:00Z', data: { commitSha: 'abcdef1' } },
    { id: 'ui-3', upstreamId: '3', repositoryId: 'r1', type: 'git.push', occurredAt: '2026-01-03T00:00:00Z', data: { confirmation: { confirmed: true, status: 'confirmed' } } },
  ];
  const result = mod.proposeProgress(current, 'r1', 'widget\nsecret', events);
  assert.equal(result.percent, 75);
  assert.equal(result.expectedVersion, 3);
  assert.match(result.summary, /^TraceMini observed 3 new Git events for widget secret; latest was push at 2026-01-03T00:00:00\.000Z\.$/);
  assert.ok(result.summary.length <= 240);
});

test('policy ignores unmatched, rejected and unconfirmed evidence and never decreases or proposes 100', () => {
  const mod = load('lib/tracemini-progress.ts');
  const current = { percent: 80, summary: 'Ahead', version: 4 };
  const events = [
    { id: 'x', upstreamId: 'x', repositoryId: 'other', type: 'commit', occurredAt: '2026-01-01T00:00:00Z', data: {} },
    { id: 'y', upstreamId: 'y', repositoryId: 'r1', type: 'git.push.rejected', occurredAt: '2026-01-02T00:00:00Z', data: { confirmation: { confirmed: true } } },
    { id: 'z', upstreamId: 'z', repositoryId: 'r1', type: 'push', occurredAt: '2026-01-03T00:00:00Z', data: { confirmation: { confirmed: false } } },
  ];
  assert.equal(mod.proposeProgress(current, 'r1', 'widget', events), null);
  const commit = mod.proposeProgress(current, 'r1', 'widget', [{ id: 'c', upstreamId: 'c', repositoryId: 'r1', type: 'commit', occurredAt: '2026-01-04T00:00:00Z', data: {} }]);
  assert.equal(commit.percent, 80);
  assert.notEqual(commit.percent, 100);
});

test('local Git facts reject every explicit negative or ambiguous confirmation state', () => {
  const mod = load('lib/tracemini-progress.ts');
  const current = { percent: 10, summary: 'Started', version: 1 };
  const rejectedConfirmations = [
    false,
    { confirmed: false },
    { status: 'unconfirmed' },
    { status: 'rejected' },
    { status: 'failed' },
    { status: 'pending' },
    { status: 'required' },
    { required: true },
    { required: true, confirmed: false },
    { status: 'error' },
    { status: 'cancelled' },
    { status: 'denied' },
    {},
    'confirmed',
  ];
  for (const type of ['clone', 'checkout', 'commit']) {
    const absent = { id: `${type}-absent`, upstreamId: `${type}-absent`, repositoryId: 'r1', type, occurredAt: '2026-01-01T00:00:00Z', data: {} };
    assert.ok(mod.proposeProgress(current, 'r1', 'widget', [absent]), `${type} without confirmation is an observed local fact`);
    for (const [index, confirmation] of rejectedConfirmations.entries()) {
      const event = { ...absent, upstreamId: `${type}-${index}`, data: { confirmation } };
      assert.equal(mod.proposeProgress(current, 'r1', 'widget', [event]), null, `${type} must reject ${JSON.stringify(confirmation)}`);
    }
    for (const [index, confirmation] of [true, { confirmed: true }, { status: 'confirmed' }, { status: 'success' }].entries()) {
      const event = { ...absent, upstreamId: `${type}-positive-${index}`, data: { confirmation } };
      assert.ok(mod.proposeProgress(current, 'r1', 'widget', [event]), `${type} must retain positive confirmation`);
    }
  }
});

test('push requires an unambiguous explicit positive confirmation', () => {
  const mod = load('lib/tracemini-progress.ts');
  const current = { percent: 10, summary: 'Started', version: 1 };
  let eventId = 0;
  const push = (confirmation, present = true) => ({ id: 'push', upstreamId: `push-${eventId++}`, repositoryId: 'r1', type: 'push', occurredAt: '2026-01-01T00:00:00Z', data: present ? { confirmation } : {} });
  for (const event of [push(undefined, false), push(false), push('confirmed'), push({}), push({ confirmed: false, status: 'success' }), push({ confirmed: true, status: 'failed' })]) {
    assert.equal(mod.proposeProgress(current, 'r1', 'widget', [event]), null);
  }
  for (const confirmation of [true, { confirmed: true }, { status: 'confirmed' }, { status: 'successful' }, { status: 'success' }]) {
    assert.equal(mod.proposeProgress(current, 'r1', 'widget', [push(confirmation)]).percent, 75);
  }
});

test('normalization preserves absent confirmation but makes supplied invalid confirmation ineligible end to end', () => {
  const progress = load('lib/tracemini-progress.ts');
  const gitRemote = load('lib/git-remote.ts');
  const normalize = load('lib/tracemini-normalize.ts', { './git-remote': gitRemote });
  const current = { percent: 10, summary: 'Started', version: 1 };
  const repository = { id: 'r1', name: 'widget', normalized_remote: 'git@github.com:acme/widget.git' };
  const normalizeEvent = (id, type, data) => normalize.normalizeTraceMiniData({
    dashboard: { repositories: [repository], events: [{ id, repository_id: 'r1', type, occurred_at: '2026-01-01T00:00:00Z', data }] },
  }, [], 'github.com/acme/widget').recentActivity[0];

  const invalid = [null, {}, { status: 'error' }, { status: 'cancelled' }, { status: 'denied' }, { status: 'unknown' }, { confirmed: 'yes' }];
  for (const [index, confirmation] of invalid.entries()) {
    const event = normalizeEvent(`invalid-${index}`, 'commit', { confirmation });
    assert.equal(event.evidenceEligible, false, `supplied ${JSON.stringify(confirmation)} must fail closed during normalization`);
    assert.equal(Object.hasOwn(event.data, 'confirmation'), false, 'raw invalid confirmation must not be exposed');
    assert.equal(progress.proposeProgress(current, 'r1', 'widget', [event]), null);
  }

  const negative = normalizeEvent('negative', 'commit', { confirmation: { status: 'rejected' } });
  assert.equal(negative.evidenceEligible, true, 'recognized safe metadata remains available to policy');
  assert.equal(progress.proposeProgress(current, 'r1', 'widget', [negative]), null, 'recognized negative confirmation must be rejected by policy');

  const absent = normalizeEvent('absent', 'commit', {});
  assert.equal(absent.evidenceEligible, true);
  assert.ok(progress.proposeProgress(current, 'r1', 'widget', [absent]), 'an absent confirmation remains a valid local fact');

  const positive = normalizeEvent('positive', 'commit', { confirmation: { confirmed: true } });
  assert.equal(positive.evidenceEligible, true);
  assert.ok(progress.proposeProgress(current, 'r1', 'widget', [positive]));

  const unconfirmedPush = normalizeEvent('push-absent', 'push', {});
  assert.equal(progress.proposeProgress(current, 'r1', 'widget', [unconfirmedPush]), null, 'push remains strict when confirmation is absent');
});

test('missing upstream IDs never become proposal evidence regardless of array order', () => {
  const mod = load('lib/tracemini-progress.ts');
  const current = { percent: 10, summary: 'Started', version: 1 };
  const events = [{ id: 'activity-0', repositoryId: 'r1', type: 'commit', occurredAt: '2026-01-01T00:00:00Z', data: { commitSha: 'abcdef1' } }, { id: 'activity-1', repositoryId: 'r1', type: 'clone', occurredAt: '2026-01-02T00:00:00Z' }];
  assert.equal(mod.proposeProgress(current, 'r1', 'widget', events), null);
  assert.equal(mod.proposeProgress(current, 'r1', 'widget', [...events].reverse()), null);
});

test('normalization displays but rejects evidence beyond the fixed future clock skew', () => {
  const progress = load('lib/tracemini-progress.ts');
  const gitRemote = load('lib/git-remote.ts');
  const normalize = load('lib/tracemini-normalize.ts', { './git-remote': gitRemote });
  const now = '2026-01-01T00:00:00.000Z';
  const repository = { id: 'r1', name: 'widget', normalized_remote: 'https://github.com/acme/widget.git' };
  const data = normalize.normalizeTraceMiniData({ dashboard: { repositories: [repository], events: [
    { id: 'near', repository_id: 'r1', type: 'commit', occurred_at: '2026-01-01T00:05:00.000Z', data: {} },
    { id: 'future', repository_id: 'r1', type: 'commit', occurred_at: '2026-01-01T00:05:00.001Z', data: {} },
  ] } }, [], 'github.com/acme/widget', now);
  assert.equal(data.recentActivity.length, 2, 'safe UI activity remains visible');
  assert.equal(data.recentActivity.find((event) => event.upstreamId === 'near').evidenceEligible, true);
  assert.equal(data.recentActivity.find((event) => event.upstreamId === 'future').evidenceEligible, false);
  const proposal = progress.proposeProgress({ percent: 10, summary: 'Started', version: 1 }, 'r1', 'widget', data.recentActivity);
  assert.deepEqual(Array.from(proposal.events, (event) => event.upstreamId), ['near']);
  assert.equal(proposal.newestOccurredAt, '2026-01-01T00:05:00.000Z');
});

test('proposal evidence deduplicates upstream IDs and repeated SHAs with stable digest under reorder', () => {
  const mod = load('lib/tracemini-progress.ts');
  const current = { percent: 10, summary: 'Started', version: 7 };
  const events = [
    { id: 'ui-a', upstreamId: 'event-a', repositoryId: 'r1', type: 'commit', occurredAt: '2026-01-01T00:00:00Z', data: { commitSha: 'abcdef1', filesChanged: 3 } },
    { id: 'ui-a-copy', upstreamId: 'event-a', repositoryId: 'r1', type: 'commit', occurredAt: '2026-01-01T00:00:00Z', data: { commitSha: 'abcdef1' } },
    { id: 'ui-b', upstreamId: 'event-b', repositoryId: 'r1', type: 'commit', occurredAt: '2026-01-02T00:00:00Z', data: { commitSha: 'abcdef1' } },
    { id: 'ui-c', upstreamId: 'event-c', repositoryId: 'r1', type: 'clone', occurredAt: '2026-01-03T00:00:00Z', data: {} },
  ];
  const first = mod.proposeProgress(current, 'r1', 'widget', events);
  const second = mod.proposeProgress(current, 'r1', 'widget', [...events].reverse());
  assert.equal(first.events.length, 2);
  assert.equal(first.summary, second.summary);
  const base = { projectId: '9', generation: '2', revision: '4', repositoryId: 'r1', progressVersion: 7 };
  assert.equal(mod.traceMiniEvidenceKey({ ...base, events: first.events }), mod.traceMiniEvidenceKey({ ...base, events: second.events }));
  assert.equal(mod.traceMiniEvidenceKey({ ...base, events: first.events }), mod.traceMiniEvidenceKey({ ...base, events: first.events.map((event) => ({ ...event, occurredAt: '2030-01-01T00:00:00Z', data: { ...event.data, filesChanged: 999 } })) }));
});

test('proposal orchestration is review-only, owner-addressed, locked and deduplicated', () => {
  const service = source('lib/tracemini.ts');
  assert.match(service, /proposeTraceMiniProgress/);
  assert.match(service, /pg_advisory_xact_lock/);
  assert.match(service, /actor_user_id[\s\S]*client_id/i);
  assert.match(service, /status='pending'/);
  assert.match(service, /config_generation[\s\S]*config_revision[\s\S]*repository/i);
  assert.match(service, /m\.repository_key\s*=\s*p\.git_repository_key/i);
  assert.match(service, /for update of p\s*,\s*i\s*,\s*m/i, 'the transactional recheck must lock project, integration, and persisted match rows');
  assert.match(service, /project_tracemini_evidence/);
  assert.match(service, /where project_id=\$1 and config_generation=\$2 and config_revision=\$3 and repository_id=\$4 and repository_key=\$5/i);
  assert.match(service, /insert into project_tracemini_evidence\(project_id,evidence_key,config_generation,config_revision,repository_id,repository_key,newest_occurred_at/i);
  assert.doesNotMatch(service, /update projects set progress_/i);
  const workspace = source('app/projects/[projectId]/WorkspaceClient.tsx');
  assert.match(workspace, /Automatic progress proposal/);
  assert.match(workspace, /loadTraceMini[\s\S]*tracemini\/data[\s\S]*method:\s*'POST'[\s\S]*await loadWorkspace\(\)/, 'UI must read data, explicitly request a proposal, then expose it during the same visit');
  assert.match(workspace, /requestId\s*!==\s*traceRequestRef\.current[\s\S]*method:\s*'POST'/, 'a stale TraceMini response must not trigger proposal creation');
  assert.match(workspace, /workspaceRequestRef\.current\s*\+=\s*1[\s\S]*requestId\s*!==\s*workspaceRequestRef\.current/, 'concurrent initial and post-proposal loads must not let stale workspace state win');
});

test('evidence watermark identity includes generation, revision, repository id and repository key', () => {
  const migration = source('migrations/018_project_git_link_and_tracemini_evidence.sql');
  for (const column of ['config_generation', 'config_revision', 'repository_id', 'repository_key']) {
    assert.match(migration, new RegExp(`${column}\\s+(?:bigint|text)\\s+not null`, 'i'));
  }
  const service = source('lib/tracemini.ts');
  assert.match(service, /\[project,\s*row\.config_generation,\s*row\.config_revision,\s*projectRow\.repository_id,\s*projectRow\.repository_key\]/);
  assert.match(service, /newest_occurred_at\s*<=\s*created_at\s*\+\s*interval\s*'5 minutes'/i, 'historical poisoned rows must not participate in a watermark');
  const mod = load('lib/tracemini-progress.ts');
  const event = { id: 'ui', upstreamId: 'event-1', repositoryId: 'repo-1', type: 'commit', occurredAt: '2026-01-01T00:00:00Z', data: {} };
  const base = { projectId: '9', generation: '1', revision: '1', repositoryId: 'repo-1', progressVersion: 1, events: [event] };
  const key = mod.traceMiniEvidenceKey(base);
  assert.notEqual(key, mod.traceMiniEvidenceKey({ ...base, generation: '2' }), 'reconfiguration generation restores an independent evidence scope');
  assert.notEqual(key, mod.traceMiniEvidenceKey({ ...base, revision: '2' }), 'revision changes restore an independent evidence scope');
  assert.notEqual(key, mod.traceMiniEvidenceKey({ ...base, repositoryId: 'repo-2', events: [{ ...event, repositoryId: 'repo-2' }] }), 'relinking to another repository restores an independent evidence scope');
});
