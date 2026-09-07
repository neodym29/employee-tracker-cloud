import {afterEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {enqueue, loadConfig, loadQueue, mutateQueue, saveConfig, saveQueue, type Config, updateConfig} from '../packages/cli/src/config.js';
import {confirmPushForClone, flush, prioritizeCandidatePaths, processPushes, processRepositorySelections, publishRepositoryCandidates, reconcileAuthorizedWorkspaces, reconcileConfiguredCloneIdentities, runAgent, scanWatchedRoots, tick, traceRepository, verifyRepositorySelection} from '../packages/cli/src/agent.js';
import {inspectRepo, installHooks, normalizeRemote, repositoryFingerprint} from '../packages/cli/src/git.js';

let temporary = '';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.TRACEMINI_HOME;
  delete process.env.TRACEMINI_QUEUE_LEASE_MS;
  if (temporary) fs.rmSync(temporary, {recursive: true, force: true});
});

const createRepo = (root: string, name: string) => {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, {recursive: true});
  execFileSync('git', ['init', '-q'], {cwd: repo});
  execFileSync('git', ['config', 'user.name', 'Selection Test'], {cwd: repo});
  execFileSync('git', ['config', 'user.email', 'selection@example.test'], {cwd: repo});
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`);
  execFileSync('git', ['add', '.'], {cwd: repo});
  execFileSync('git', ['commit', '-qm', `Create ${name}`], {cwd: repo});
  return repo;
};

describe('device repository selection', () => {
  it('removes only local state belonging to workspaces no longer authorized', () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-workspace-access-'));
    process.env.TRACEMINI_HOME = temporary;
    const one = {path: '/clone/shared', workspaceId: 1, repositoryId: 7, normalizedRemote: 'one/repo', name: 'one', repositoryFingerprint: 'a'.repeat(64)};
    const two = {path: '/clone/shared', workspaceId: 2, repositoryId: 8, normalizedRemote: 'two/repo', name: 'two', repositoryFingerprint: 'a'.repeat(64)};
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 1, watchedPaths: ['/root/one', '/root/two'], watchedRoots: [{path: '/root/one', workspaceId: 1}, {path: '/root/two', workspaceId: 2}], clones: [one, two], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    saveQueue([
      {eventKey: 'one', workspaceId: 1, repositoryId: 7, localKey: one.path, identityFingerprint: one.repositoryFingerprint, type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0},
      {eventKey: 'two', workspaceId: 2, repositoryId: 8, localKey: two.path, identityFingerprint: two.repositoryFingerprint, type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0},
    ]);

    reconcileAuthorizedWorkspaces(config, [2], new Map());

    expect(loadConfig().clones).toEqual([expect.objectContaining({workspaceId: 2, repositoryId: 8})]);
    expect(loadConfig()).toMatchObject({workspaceId: 2, watchedPaths: ['/root/one', '/root/two'], watchedRoots: []});
    expect(loadQueue()).toEqual([expect.objectContaining({workspaceId: 2, repositoryId: 8})]);
  });

  it('keeps device watch paths while removing departed workspace events', () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-membership-root-cleanup-'));
    process.env.TRACEMINI_HOME = temporary;
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 1, watchedPaths: ['/departed'], watchedRoots: [{path: '/departed', workspaceId: 1}], clones: [], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    saveQueue([{eventKey: 'departed', workspaceId: 1, repositoryId: 7, localKey: '/departed/repo', type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0}]);

    expect(reconcileAuthorizedWorkspaces(config, [2], new Map())).toBe(0);

    expect(loadConfig()).toMatchObject({workspaceId: 2, watchedPaths: ['/departed'], watchedRoots: [], clones: []});
    expect(loadQueue()).toEqual([]);
  });

  it('publishes every device root but only clones scoped to the selected workspace', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-workspace-candidates-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const projects = path.join(temporary, 'projects');
    const one = createRepo(projects, 'one');
    const two = createRepo(projects, 'two');
    const infoOne = inspectRepo(one);
    const infoTwo = inspectRepo(two);
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 2, watchedPaths: [one, two], watchedRoots: [{path: one, workspaceId: 1}, {path: two, workspaceId: 2}], clones: [
      {path: one, workspaceId: 1, repositoryId: 7, normalizedRemote: normalizeRemote(infoOne.remoteUrl), name: infoOne.name, repositoryFingerprint: repositoryFingerprint(one)},
      {path: two, workspaceId: 2, repositoryId: 8, normalizedRemote: normalizeRemote(infoTwo.remoteUrl), name: infoTwo.name, repositoryFingerprint: repositoryFingerprint(two)},
    ], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    let published: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
      published = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }));

    await publishRepositoryCandidates(loadConfig());

    expect(published.workspaceId).toBe(2);
    expect(published.repositories.map((candidate: any) => candidate.localKey)).toEqual(expect.arrayContaining([one, two]));
  });

  it('reserves the bounded candidate list for configured clones before discoveries', () => {
    expect(prioritizeCandidatePaths(['/trusted/outside'], Array.from({length: 500}, (_, index) => `/discovered/${index}`))).toEqual([
      '/trusted/outside',
      ...Array.from({length: 499}, (_, index) => `/discovered/${index}`),
    ]);
  });

  it('persists an empty watched root and discovers repositories created there later', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-watched-root-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const watchedRoot = path.join(temporary, 'external-projects');
    const ordinaryRoot = path.join(temporary, 'ordinary-home');
    fs.mkdirSync(watchedRoot);
    fs.mkdirSync(ordinaryRoot);
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 2, watchedPaths: [], clones: [], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    const candidateBodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (new URL(url).pathname === '/api/agents/repository-candidates') candidateBodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }));
    expect(await scanWatchedRoots(config, [watchedRoot])).toBe(0);
    expect(loadConfig().watchedPaths).toContain(watchedRoot);
    const future = createRepo(watchedRoot, 'future');
    await publishRepositoryCandidates(loadConfig(), ordinaryRoot);
    expect(candidateBodies.at(-1).repositories).toEqual(expect.arrayContaining([expect.objectContaining({localKey: future, traced: false})]));
    const info = inspectRepo(future);
    expect(() => verifyRepositorySelection(loadConfig(), {local_key: future, normalized_remote: normalizeRemote(info.remoteUrl)}, ordinaryRoot)).not.toThrow();
    expect(() => verifyRepositorySelection({...loadConfig(), watchedPaths: [], watchedRoots: []}, {local_key: future, normalized_remote: normalizeRemote(info.remoteUrl)})).toThrow('outside the approved discovery root');
  });

  it('keeps repository roots valid when only the preferred workspace changes', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-stale-scan-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const oldRoot = path.join(temporary, 'old-root');
    fs.mkdirSync(oldRoot);
    const stale: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 1, watchedPaths: [oldRoot], clones: [], reporter: 'hermes', pollMs: 2000};
    saveConfig(stale, {replaceCollections: true});
    saveConfig({...stale, workspaceId: 2, watchedPaths: [], clones: []}, {replaceCollections: true});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ok: true}), {status: 200})));

    expect(await scanWatchedRoots(stale, [oldRoot])).toBe(0);
    expect(loadConfig()).toMatchObject({workspaceId: 2, watchedPaths: [oldRoot], clones: []});
  });

  it('applies a repository selection from an authorized non-preferred workspace', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-non-preferred-selection-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const root = path.join(temporary, 'workspace-two');
    const repo = createRepo(root, 'selected');
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 1, watchedPaths: [root], watchedRoots: [{path: root, workspaceId: 2}], clones: [], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/agents/repository-selections') return new Response(JSON.stringify([{id: 9, workspace_id: 2, revision: 1, local_key: repo, name: 'selected', remote_url: `local:${repo}`, normalized_remote: normalizeRemote(`local:${repo}`), desired_traced: true, traced: false}]), {status: 200});
      if (pathname === '/api/repositories/register') return new Response(JSON.stringify({id: 77, name: 'selected', normalized_remote: `local/${repo}`}), {status: 200});
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }));

    await processRepositorySelections(config);

    expect(loadConfig().clones).toEqual([expect.objectContaining({path: repo, workspaceId: 2, repositoryId: 77})]);
  });

  it.each(['success', 'failure'] as const)('does not let a stale repository-selection %s continuation alter a rebound device', async outcome => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), `tracemini-stale-selection-${outcome}-`));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const root = path.join(temporary, 'workspace');
    const repo = createRepo(root, 'selected');
    const fingerprint = repositoryFingerprint(repo);
    const oldConfig: Config = {serverUrl: 'https://trace.example', agentToken: 'old-token', agentId: 1, workspaceId: 1, watchedPaths: [root], watchedRoots: [{path: root, workspaceId: 1}], clones: [], reporter: 'hermes', pollMs: 2000};
    saveConfig(oldConfig, {replaceCollections: true});
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/agents/repository-selections') return new Response(JSON.stringify([{id: 9, workspace_id: 1, revision: 1, local_key: repo, name: 'selected', remote_url: `local:${repo}`, normalized_remote: normalizeRemote(`local:${repo}`), desired_traced: true, traced: false}]), {status: 200});
      if (pathname === '/api/repositories/register') {
        started();
        await blocked;
        return outcome === 'success'
          ? new Response(JSON.stringify({id: 77, name: 'selected', normalized_remote: normalizeRemote(`local-device-1:${repo}`)}), {status: 200})
          : new Response(JSON.stringify({error: 'registration failed'}), {status: 500});
      }
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }));
    const processing = processRepositorySelections(oldConfig);
    await requested;
    const rebound: Config = {serverUrl: 'https://trace.example', agentToken: 'new-token', agentId: 2, workspaceId: 1, watchedPaths: [root], watchedRoots: [{path: root, workspaceId: 1}], clones: [{path: repo, workspaceId: 1, repositoryId: 88, normalizedRemote: normalizeRemote(`local-device-2:${repo}`), name: 'selected', repositoryFingerprint: fingerprint}], reporter: 'hermes', pollMs: 2000};
    saveConfig(rebound, {replaceCollections: true});
    installHooks(repo);
    release();
    await processing;

    expect(loadConfig()).toMatchObject({agentId: 2, agentToken: 'new-token'});
    expect(loadConfig().clones).toEqual([expect.objectContaining({workspaceId: 1, repositoryId: 88})]);
    expect(loadConfig().clones).not.toEqual(expect.arrayContaining([expect.objectContaining({workspaceId: 1, repositoryId: 77})]));
    expect(fs.readFileSync(path.join(repo, '.git', 'hooks', 'post-commit'), 'utf8')).toContain('TraceMini managed hook');
  });

  it('ignores a stale control-sync response after the device binding changes', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-stale-heartbeat-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const root = path.join(temporary, 'workspace-two');
    const repo = createRepo(root, 'selected');
    const fingerprint = repositoryFingerprint(repo);
    const oldConfig: Config = {serverUrl: 'https://trace.example', agentToken: 'old-token', agentId: 1, workspaceId: 1, watchedPaths: [root], watchedRoots: [{path: root, workspaceId: 1}], clones: [{path: repo, workspaceId: 1, repositoryId: 7, normalizedRemote: 'old/repo', name: 'selected', repositoryFingerprint: fingerprint}], reporter: 'hermes', pollMs: 2000};
    saveConfig(oldConfig, {replaceCollections: true});
    installHooks(repo);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (new URL(url).pathname === '/api/agents/sync') {
        started();
        await blocked;
        return new Response(JSON.stringify({workspaceIds: [99], jobs: [], refreshRequests: [], repositorySelections: [], pushes: []}), {status: 200});
      }
      if (new URL(url).pathname === '/api/activity') return new Response(JSON.stringify({error: 'offline'}), {status: 503});
      return new Response(JSON.stringify([]), {status: 200});
    }));
    const running = runAgent(oldConfig, true);
    await requested;
    const rebound: Config = {serverUrl: 'https://trace.example', agentToken: 'new-token', agentId: 2, workspaceId: 2, watchedPaths: [root], watchedRoots: [{path: root, workspaceId: 2}], clones: [{path: repo, workspaceId: 2, repositoryId: 8, normalizedRemote: normalizeRemote(`local-device-2:${repo}`), name: 'selected', repositoryFingerprint: fingerprint}], reporter: 'hermes', pollMs: 2000};
    saveConfig(rebound, {replaceCollections: true});
    saveQueue([{eventKey: 'new-binding', workspaceId: 2, repositoryId: 8, localKey: repo, identityFingerprint: fingerprint, type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0}]);
    release();
    await running;

    expect(loadConfig()).toMatchObject({agentId: 2, agentToken: 'new-token', workspaceId: 2, watchedPaths: [root], watchedRoots: [], clones: [expect.objectContaining({path: repo, workspaceId: 2, repositoryId: 8})]});
    expect(loadQueue()).toEqual([expect.objectContaining({eventKey: 'new-binding', workspaceId: 2})]);
    expect(fs.readFileSync(path.join(repo, '.git', 'hooks', 'post-commit'), 'utf8')).toContain('TraceMini managed hook');
  });

  it('drops legacy queue entries instead of guessing among duplicate clone paths', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-legacy-queue-'));
    process.env.TRACEMINI_HOME = temporary;
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 1, watchedPaths: [], clones: [
      {path: '/clone/one', repositoryId: 7, normalizedRemote: 'example/repo', name: 'repo'},
      {path: '/clone/two', repositoryId: 7, normalizedRemote: 'example/repo', name: 'repo'},
    ], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    saveQueue([{eventKey: 'legacy', repositoryId: 7, type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0}]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await flush(config)).toEqual({sent: 0, pending: 0});
    expect(loadQueue()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops a legacy event when one physical clone maps to multiple workspace partitions', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-ambiguous-workspace-queue-'));
    process.env.TRACEMINI_HOME = temporary;
    const fingerprint = 'a'.repeat(64);
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 2, watchedPaths: [], clones: [
      {path: '/clone/shared', workspaceId: 1, repositoryId: 7, normalizedRemote: 'one/repo', name: 'repo', repositoryFingerprint: fingerprint},
      {path: '/clone/shared', workspaceId: 2, repositoryId: 7, normalizedRemote: 'two/repo', name: 'repo', repositoryFingerprint: fingerprint},
    ], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    saveQueue([{eventKey: 'legacy-shared', repositoryId: 7, localKey: '/clone/shared', identityFingerprint: fingerprint, type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0}]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await flush(config)).toEqual({sent: 0, pending: 0});
    expect(loadQueue()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hydrates an unambiguous legacy event from its clone instead of the preferred workspace', () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-unambiguous-workspace-queue-'));
    process.env.TRACEMINI_HOME = temporary;
    const fingerprint = 'a'.repeat(64);
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 2, watchedPaths: [], clones: [
      {path: '/clone/shared', workspaceId: 1, repositoryId: 7, normalizedRemote: 'one/repo', name: 'repo', repositoryFingerprint: fingerprint},
      {path: '/clone/shared', workspaceId: 2, repositoryId: 8, normalizedRemote: 'two/repo', name: 'repo', repositoryFingerprint: fingerprint},
    ], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    saveQueue([{eventKey: 'legacy-one', repositoryId: 7, localKey: '/clone/shared', identityFingerprint: fingerprint, type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0}]);

    expect(loadQueue()).toEqual([expect.objectContaining({eventKey: 'legacy-one', workspaceId: 1})]);
  });

  it('queues one physical staged-index observation across workspace clone partitions', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-stage-fanout-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const repo = createRepo(path.join(temporary, 'root'), 'shared');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged');
    execFileSync('git', ['add', 'staged.txt'], {cwd: repo});
    const info = inspectRepo(repo);
    const fingerprint = repositoryFingerprint(repo);
    const clones = [1, 2].map(workspaceId => ({path: repo, workspaceId, repositoryId: 70 + workspaceId, normalizedRemote: normalizeRemote(`local-device-1:${repo}`), name: 'shared', repositoryFingerprint: fingerprint, branch: info.branch, headSha: info.headSha}));
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 1, watchedPaths: [], clones: [clones[0]], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), {status: 200})));
    await tick(config, new Map([[repo, {mtime: 0}]]));
    updateConfig(current => { current.clones.push(clones[1]); });
    await new Promise(resolve => setTimeout(resolve, 1400));

    expect(loadQueue().map(event => [event.workspaceId, event.repositoryId])).toEqual([[1, 71]]);
  });

  it('notifies every workspace partition when push verification detects a shared-path identity change', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-shared-identity-change-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const repo = createRepo(path.join(temporary, 'root'), 'shared');
    const fingerprint = repositoryFingerprint(repo);
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 1, watchedPaths: [], clones: [
      {path: repo, workspaceId: 1, repositoryId: 7, normalizedRemote: 'one/repo', name: 'shared', repositoryFingerprint: fingerprint},
      {path: repo, workspaceId: 2, repositoryId: 8, normalizedRemote: 'two/repo', name: 'shared', repositoryFingerprint: fingerprint},
    ], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    const notifications: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/agents/pushes') return new Response(JSON.stringify([{id: 9, local_key: repo, repository_id: 7, repository_fingerprint: 'b'.repeat(64)}]), {status: 200});
      if (pathname === '/api/agents/repository-candidates') notifications.push(JSON.parse(String(init.body)).workspaceId);
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }));

    await processPushes(config);

    expect(loadConfig().clones).toEqual([]);
    expect(notifications.sort()).toEqual([1, 2]);
  });

  it('does not let stale push identity cleanup erase a rebound device at the same path', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-stale-push-cleanup-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const repo = createRepo(path.join(temporary, 'root'), 'shared');
    const fingerprint = repositoryFingerprint(repo);
    const oldConfig: Config = {serverUrl: 'https://trace.example', agentToken: 'old-token', agentId: 1, workspaceId: 1, watchedPaths: [], clones: [{path: repo, workspaceId: 1, repositoryId: 7, normalizedRemote: 'one/repo', name: 'shared', repositoryFingerprint: fingerprint}], reporter: 'hermes', pollMs: 2000};
    saveConfig(oldConfig, {replaceCollections: true});
    installHooks(repo);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (new URL(url).pathname === '/api/agents/pushes') {
        started();
        await blocked;
        return new Response(JSON.stringify([{id: 9, local_key: repo, repository_id: 7, repository_fingerprint: 'b'.repeat(64), occurred_at: '2000-01-01T00:00:00.000Z'}]), {status: 200});
      }
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }));
    const processing = processPushes(oldConfig);
    await requested;
    const rebound: Config = {serverUrl: 'https://trace.example', agentToken: 'new-token', agentId: 2, workspaceId: 1, watchedPaths: [], clones: [{path: repo, workspaceId: 1, repositoryId: 88, normalizedRemote: 'two/repo', name: 'shared', repositoryFingerprint: fingerprint}], reporter: 'hermes', pollMs: 2000};
    saveConfig(rebound, {replaceCollections: true});
    installHooks(repo);
    release();
    await processing;

    expect(loadConfig()).toMatchObject({agentId: 2, agentToken: 'new-token', clones: [expect.objectContaining({repositoryId: 88})]});
    expect(fs.readFileSync(path.join(repo, '.git', 'hooks', 'post-commit'), 'utf8')).toContain('TraceMini managed hook');
  });

  it('does not let stale identity reconciliation erase a rebound device at the same path', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-stale-identity-reconcile-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const repo = createRepo(path.join(temporary, 'root'), 'shared');
    const fingerprint = repositoryFingerprint(repo);
    const oldConfig: Config = {serverUrl: 'https://trace.example', agentToken: 'old-token', agentId: 1, workspaceId: 1, watchedPaths: [], clones: [{path: repo, workspaceId: 1, repositoryId: 7, normalizedRemote: normalizeRemote(`local-device-1:${repo}`), name: 'shared', repositoryFingerprint: 'b'.repeat(64)}], reporter: 'hermes', pollMs: 2000};
    saveConfig(oldConfig, {replaceCollections: true});
    const rebound: Config = {serverUrl: 'https://trace.example', agentToken: 'new-token', agentId: 2, workspaceId: 1, watchedPaths: [], clones: [{path: repo, workspaceId: 1, repositoryId: 88, normalizedRemote: normalizeRemote(`local-device-2:${repo}`), name: 'shared', repositoryFingerprint: fingerprint}], reporter: 'hermes', pollMs: 2000};
    const originalRealpath = fs.realpathSync;
    let reboundSaved = false;
    vi.spyOn(fs, 'realpathSync').mockImplementation(((target: fs.PathLike) => {
      if (!reboundSaved && String(target) === repo) {
        reboundSaved = true;
        saveConfig(rebound, {replaceCollections: true});
        saveQueue([{eventKey: 'new-device', workspaceId: 1, repositoryId: 88, localKey: repo, identityFingerprint: fingerprint, type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0}]);
        installHooks(repo);
      }
      return originalRealpath(target);
    }) as typeof fs.realpathSync);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ok: true}), {status: 200})));
    await reconcileConfiguredCloneIdentities(oldConfig, new Map());
    expect(loadConfig()).toMatchObject({agentId: 2, agentToken: 'new-token', clones: [expect.objectContaining({repositoryId: 88})]});
    expect(loadQueue()).toEqual([expect.objectContaining({eventKey: 'new-device', repositoryId: 88})]);
    expect(fs.readFileSync(path.join(repo, '.git', 'hooks', 'post-commit'), 'utf8')).toContain('TraceMini managed hook');
  });

  it('does not let a stale flush disclose or delete the rebound device queue', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-stale-flush-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const clone = {path: '/shared', workspaceId: 1, repositoryId: 88, normalizedRemote: 'new/repo', name: 'shared', repositoryFingerprint: 'a'.repeat(64)};
    const oldConfig: Config = {serverUrl: 'https://old.example', agentToken: 'old-token', agentId: 1, workspaceId: 1, watchedPaths: [], clones: [clone], reporter: 'hermes', pollMs: 2000};
    const rebound: Config = {...oldConfig, serverUrl: 'https://new.example', agentToken: 'new-token', agentId: 2};
    saveConfig(rebound, {replaceCollections: true});
    saveQueue([{eventKey: 'new-device-event', workspaceId: 1, repositoryId: 88, localKey: clone.path, identityFingerprint: clone.repositoryFingerprint, type: 'commit', occurredAt: new Date().toISOString(), data: {private: 'new-device'}, attempts: 0, nextAttempt: 0}]);
    const request = vi.fn(async () => new Response(JSON.stringify({ok: true}), {status: 200}));
    vi.stubGlobal('fetch', request);

    expect(await flush(oldConfig)).toEqual({sent: 0, pending: 1});
    expect(request).not.toHaveBeenCalled();
    expect(loadQueue()).toEqual([expect.objectContaining({eventKey: 'new-device-event'})]);
    expect(loadQueue()[0]).not.toHaveProperty('claimId');
  });

  it('does not let a stale binding enqueue into a rebound device queue', () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-stale-enqueue-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const clone = {path: '/shared', workspaceId: 1, repositoryId: 88, normalizedRemote: 'shared/repo', name: 'shared', repositoryFingerprint: 'a'.repeat(64)};
    const oldConfig: Config = {serverUrl: 'https://old.example', agentToken: 'old-token', agentId: 1, workspaceId: 1, watchedPaths: [], clones: [clone], reporter: 'hermes', pollMs: 2000};
    saveConfig({...oldConfig, serverUrl: 'https://new.example', agentToken: 'new-token', agentId: 2}, {replaceCollections: true});
    const staleEvent = {eventKey: 'old-binding-event', workspaceId: 1, repositoryId: 88, localKey: clone.path, identityFingerprint: clone.repositoryFingerprint, type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0};

    expect(enqueue(oldConfig, staleEvent)).toBe(false);
    expect(loadQueue()).toEqual([]);
  });

  it('does not admit a cross-workspace event through a legacy clone without workspaceId', () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-legacy-clone-enqueue-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const fingerprint = 'a'.repeat(64);
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 1, watchedPaths: [], clones: [{path: '/shared', repositoryId: 7, normalizedRemote: 'shared/repo', name: 'shared', repositoryFingerprint: fingerprint}], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    const crossWorkspaceEvent = {eventKey: 'workspace-two', workspaceId: 2, repositoryId: 7, localKey: '/shared', identityFingerprint: fingerprint, type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0};

    expect(enqueue(config, crossWorkspaceEvent)).toBe(false);
    expect(loadQueue()).toEqual([]);
  });

  it('does not resurrect an in-flight failed event after its clone is deselected', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-queue-deselect-'));
    process.env.TRACEMINI_HOME = temporary;
    const clone = {path: '/clone/selected', workspaceId: 1, repositoryId: 7, normalizedRemote: 'example/repo', name: 'repo', repositoryFingerprint: 'a'.repeat(64)};
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', workspaceId: 1, watchedPaths: [], clones: [clone], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    saveQueue([{eventKey: 'in-flight', repositoryId: 7, localKey: clone.path, identityFingerprint: clone.repositoryFingerprint, type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0}]);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let requested!: () => void;
    const started = new Promise<void>(resolve => { requested = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => { requested(); await blocked; throw new Error('offline'); }));
    const flushing = flush(config);
    await started;
    expect(loadQueue()).toEqual([expect.objectContaining({eventKey: 'in-flight', claimId: expect.any(String), claimedAt: expect.any(Number)})]);
    updateConfig(current => { current.clones = []; });
    mutateQueue(queue => queue.splice(0));
    release();
    await flushing;
    expect(loadQueue()).toEqual([]);
  });

  it('recovers a durably claimed event after a crashed flush lease expires', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-queue-recovery-'));
    process.env.TRACEMINI_HOME = temporary;
    process.env.TRACEMINI_QUEUE_LEASE_MS = '1000';
    const clone = {path: '/clone/selected', workspaceId: 1, repositoryId: 7, normalizedRemote: 'example/repo', name: 'repo', repositoryFingerprint: 'a'.repeat(64)};
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', workspaceId: 1, watchedPaths: [], clones: [clone], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    saveQueue([{eventKey: 'crashed', repositoryId: 7, localKey: clone.path, identityFingerprint: clone.repositoryFingerprint, type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0, claimId: 'dead-process', claimedAt: Date.now() - 2000}]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ok: true}), {status: 201})));
    expect(await flush(config)).toEqual({sent: 1, pending: 0});
    expect(loadQueue()).toEqual([]);
  });

  it('fails closed when a selected repository path is replaced', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-replaced-repo-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const repo = createRepo(temporary, 'selected');
    const originalFingerprint = repositoryFingerprint(repo);
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 2, watchedPaths: [temporary], clones: [{path: repo, repositoryId: 7, normalizedRemote: normalizeRemote(`local-device-1:${repo}`), name: 'selected', repositoryFingerprint: originalFingerprint}], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    fs.writeFileSync(path.join(repo, 'next.txt'), 'next');
    execFileSync('git', ['add', '.'], {cwd: repo});
    execFileSync('git', ['commit', '-qm', 'normal activity'], {cwd: repo});
    expect(repositoryFingerprint(repo)).toBe(originalFingerprint);
    fs.rmSync(path.join(repo, '.git'), {recursive: true, force: true});
    execFileSync('git', ['init', '-q'], {cwd: repo});
    const candidateBodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit = {}) => {
      candidateBodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }));
    await reconcileConfiguredCloneIdentities(config, new Map());
    expect(loadConfig().clones).toEqual([]);
    expect(candidateBodies).toEqual([expect.objectContaining({repositories: [expect.objectContaining({localKey: repo, traced: false, identityChanged: true})]})]);
  });

  it('rejects push confirmation when the repository is replaced during remote verification', () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-push-identity-race-'));
    const repo = createRepo(temporary, 'selected');
    const fingerprint = repositoryFingerprint(repo);
    const clone = {path: repo, repositoryId: 7, normalizedRemote: 'local/repo', name: 'selected', repositoryFingerprint: fingerprint};
    expect(() => confirmPushForClone(clone, {repository_fingerprint: fingerprint}, () => {
      fs.rmSync(path.join(repo, '.git'), {recursive: true, force: true});
      execFileSync('git', ['init', '-q'], {cwd: repo});
      return {status: 'confirmed' as const, observedSha: 'abc'};
    })).toThrow('repository identity changed');
  });

  it('fails closed when a repository is replaced during registration', async () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-registration-race-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const repo = createRepo(temporary, 'selected');
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 2, watchedPaths: [temporary], clones: [], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const pathname = new URL(url).pathname;
      paths.push(pathname);
      if (pathname === '/api/repositories/register') {
        fs.rmSync(path.join(repo, '.git'), {recursive: true, force: true});
        execFileSync('git', ['init', '-q'], {cwd: repo});
        execFileSync('git', ['config', 'user.name', 'Replacement'], {cwd: repo});
        execFileSync('git', ['config', 'user.email', 'replacement@example.test'], {cwd: repo});
        fs.writeFileSync(path.join(repo, 'replacement.txt'), 'replacement');
        execFileSync('git', ['add', '.'], {cwd: repo});
        execFileSync('git', ['commit', '-qm', 'replacement'], {cwd: repo});
        return new Response(JSON.stringify({id: 7, name: 'selected', normalized_remote: normalizeRemote(`local-device-1:${repo}`)}), {status: 200});
      }
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }));
    await expect(traceRepository(config, repo)).rejects.toThrow('repository identity changed');
    expect(config.clones).toEqual([]);
    expect(paths).not.toContain('/api/activity');
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'post-commit'))).toBe(false);
  });

  it('rejects a discovered path that is later redirected outside the discovery root', () => {
    temporary = fs.mkdtempSync(path.join(os.homedir(), '.tracemini-repository-selection-test-'));
    const root = path.join(temporary, 'root');
    const outside = path.join(temporary, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    execFileSync('git', ['init'], {cwd: outside, stdio: 'ignore'});
    const target = outside;
    const localKey = path.join(root, 'candidate');
    fs.symlinkSync(target, localKey, 'dir');
    expect(() => verifyRepositorySelection({clones: []} as any, {local_key: localKey, normalized_remote: normalizeRemote(`local:${localKey}`)}, root)).toThrow('outside the approved discovery root');
  });

  it('publishes every discoverable repo and applies a trace selection', async () => {
    temporary = fs.mkdtempSync(path.join(os.homedir(), '.tracemini-repository-selection-test-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const projects = path.join(temporary, 'projects');
    const selected = createRepo(projects, 'selected');
    const available = createRepo(projects, 'available');
    const config: Config = {serverUrl: 'https://trace.example', agentToken: 'device-token', agentId: 1, workspaceId: 2, watchedPaths: [selected, available], clones: [], reporter: 'hermes', pollMs: 2000};
    saveConfig(config, {replaceCollections: true});
    const candidateBodies: any[] = [];
    let desiredTraced = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const pathname = new URL(url).pathname;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (pathname === '/api/agents/repository-candidates') candidateBodies.push(body);
      if (pathname === '/api/agents/repository-selections' && (!init.method || init.method === 'GET')) return new Response(JSON.stringify([{id: 9, workspace_id: 2, revision: 1, local_key: available, name: 'available', remote_url: `local:${available}`, normalized_remote: normalizeRemote(`local:${available}`), desired_traced: desiredTraced, traced: !desiredTraced}]), {status: 200});
      if (pathname === '/api/repositories/register') return new Response(JSON.stringify({id: 77, name: 'available', normalized_remote: `local/${available}`}), {status: 200});
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }));

    await publishRepositoryCandidates(config, projects);
    expect(candidateBodies[0].repositories).toEqual(expect.arrayContaining([
      expect.objectContaining({localKey: selected, traced: false}),
      expect.objectContaining({localKey: available, traced: false}),
    ]));

    await processRepositorySelections(config);
    const stored = loadConfig();
    expect(stored.watchedPaths).toEqual([selected, available]);
    expect(stored.clones).toEqual([expect.objectContaining({path: available, repositoryId: 77})]);
    expect(fs.readFileSync(path.join(available, '.git', 'hooks', 'post-commit'), 'utf8')).toContain('TraceMini managed hook');

    desiredTraced = false;
    await processRepositorySelections(stored);
    const stopped = loadConfig();
    expect(stopped.watchedPaths).toContain(available);
    expect(stopped.clones).toEqual([]);
    expect(fs.existsSync(path.join(available, '.git', 'hooks', 'post-commit'))).toBe(false);
  });
});
