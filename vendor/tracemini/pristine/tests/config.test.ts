import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadConfig, loadQueue, mutateCurrentBinding, saveConfig, saveQueue} from '../packages/cli/src/config.js';

const originalHome = process.env.TRACEMINI_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.TRACEMINI_HOME;
  else process.env.TRACEMINI_HOME = originalHome;
});

describe('concurrent CLI configuration', () => {
  it('keeps the same physical clone registered independently in two workspaces', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-shared-clone-'));
    process.env.TRACEMINI_HOME = home;
    const base = {...loadConfig(), serverUrl: 'https://trace.example', agentToken: 'device', agentId: 1, workspaceId: 1};
    base.clones = [
      {path: '/work/shared', workspaceId: 1, repositoryId: 11, normalizedRemote: 'one/repo', name: 'one'},
      {path: '/work/shared', workspaceId: 2, repositoryId: 22, normalizedRemote: 'two/repo', name: 'two'},
    ];

    saveConfig(base, {replaceCollections: true});

    expect(loadConfig().clones).toEqual([
      expect.objectContaining({path: '/work/shared', workspaceId: 1, repositoryId: 11}),
      expect.objectContaining({path: '/work/shared', workspaceId: 2, repositoryId: 22}),
    ]);
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('does not scan any directory until the user explicitly chooses a watch root', () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-default-home-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-user-home-'));
    process.env.TRACEMINI_HOME = state;
    const originalUserHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      expect(loadConfig().watchedPaths).toEqual([]);
      fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({watchedPaths: []}));
      expect(loadConfig().watchedPaths).toEqual([]);
    } finally {
      if (originalUserHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalUserHome;
      fs.rmSync(state, {recursive: true, force: true});
      fs.rmSync(fakeHome, {recursive: true, force: true});
    }
  });

  it('serializes real cross-process config writers without losing updates', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-config-processes-'));
    process.env.TRACEMINI_HOME = home;
    const gate = path.join(home, 'gate');
    fs.mkdirSync(path.join(home, 'config.lock'), {mode: 0o700});
    fs.writeFileSync(path.join(home, 'config.lock', 'owner'), '2147483647', {mode: 0o600});
    const worker = fileURLToPath(new URL('./fixtures/config-writer.ts', import.meta.url));
    const roots = Array.from({length: 16}, (_, index) => `/work/repo-${index}`);
    const children = roots.map((root, index) => spawn(process.execPath, ['--import', 'tsx', worker, root, gate, path.join(home, `ready-${index}`)], {
      env: {...process.env, TRACEMINI_HOME: home}, stdio: 'ignore',
    }));
    while (roots.some((_, index) => !fs.existsSync(path.join(home, `ready-${index}`)))) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    fs.writeFileSync(gate, 'go');
    await Promise.all(children.map(child => new Promise<void>((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error(`config writer exited ${code}`))))));

    expect(loadConfig().watchedPaths.sort()).toEqual(roots.sort());
    fs.rmSync(home, {recursive: true, force: true});
  }, 20_000);

  it('does not let a running agent overwrite roots and clones added by the watch command', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-config-'));
    process.env.TRACEMINI_HOME = home;
    saveConfig({...loadConfig(), serverUrl: 'http://localhost:43118', workspaceId: 1, agentToken: 'agent'});

    const staleAgentConfig = loadConfig();
    const watchConfig = loadConfig();
    watchConfig.watchedPaths.push('/tmp/watched');
    watchConfig.clones.push({path: '/tmp/watched/repo', repositoryId: 7, normalizedRemote: 'file:///tmp/remote', name: 'repo'});
    saveConfig(watchConfig);

    saveConfig(staleAgentConfig);

    expect(loadConfig()).toMatchObject({
      watchedPaths: ['/tmp/watched'],
      clones: [{path: '/tmp/watched/repo', repositoryId: 7}],
    });
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('preserves interactive scalar settings when a stale background scan saves discoveries', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-config-'));
    process.env.TRACEMINI_HOME = home;
    const staleAgent = {...loadConfig(), workspaceId: 1, agentId: 11};
    saveConfig(staleAgent);
    saveConfig({...loadConfig(), workspaceId: 2, agentId: 22});

    saveConfig(staleAgent, {preserveCurrentScalars: true});

    expect(loadConfig()).toMatchObject({workspaceId: 2, agentId: 22});
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('ignores repository state from the same numeric IDs on another server binding', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-config-'));
    process.env.TRACEMINI_HOME = home;
    const clone = {path: '/work/repo', repositoryId: 7, normalizedRemote: 'example/repo', name: 'repo', headSha: 'old'};
    const stale = {...loadConfig(), serverUrl: 'https://old.example', workspaceId: 2, agentId: 22, agentToken: 'old-token', clones: [{...clone, headSha: 'new'}]};
    saveConfig(stale);
    saveConfig({...loadConfig(), serverUrl: 'https://new.example', workspaceId: 2, agentId: 22, agentToken: 'new-token', clones: [clone]}, {replaceRepositoryState: true});

    saveConfig(stale, {preserveCurrentScalars: true});

    expect(loadConfig()).toMatchObject({serverUrl: 'https://new.example', workspaceId: 2, agentId: 22, agentToken: 'new-token', clones: [{repositoryId: 7, headSha: 'old'}]});
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('rejects a stale queue save after the device binding changes', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-config-'));
    process.env.TRACEMINI_HOME = home;
    const stale = {...loadConfig(), serverUrl: 'https://old.example', workspaceId: 1, agentId: 1, agentToken: 'old-token'};
    saveConfig(stale);
    saveQueue([{eventKey: 'old', repositoryId: 1, type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0}], stale);
    const current = {...loadConfig(), serverUrl: 'https://new.example', workspaceId: 1, agentId: 1, agentToken: 'new-token', watchedPaths: [], clones: []};
    saveConfig(current, {replaceRepositoryState: true});
    saveQueue([], current);

    expect(saveQueue([{eventKey: 'resurrected', repositoryId: 1, type: 'commit', occurredAt: new Date().toISOString(), data: {}, attempts: 0, nextAttempt: 0}], stale)).toBe(false);
    expect(loadQueue()).toEqual([]);
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('replaces repository state when switching workspaces', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-config-'));
    process.env.TRACEMINI_HOME = home;
    saveConfig({...loadConfig(), workspaceId: 1, watchedPaths: ['/one'], clones: [{path: '/one/repo', repositoryId: 7, normalizedRemote: 'one/repo', name: 'repo'}]});
    const switched = {...loadConfig(), workspaceId: 2, watchedPaths: [], clones: []};

    saveConfig(switched, {replaceRepositoryState: true});

    expect(loadConfig()).toMatchObject({workspaceId: 2, watchedPaths: [], clones: []});
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('cleans the latest persisted clone list during a stale workspace reset', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-config-'));
    process.env.TRACEMINI_HOME = home;
    saveConfig({...loadConfig(), workspaceId: 1, agentId: 1, agentToken: 'token'});
    const staleReset = loadConfig();
    saveConfig({...loadConfig(), watchedPaths: ['/new'], clones: [{path: '/new/repo', repositoryId: 7, normalizedRemote: 'new/repo', name: 'repo'}]});
    const cleaned: string[] = [];
    staleReset.workspaceId = 2;
    staleReset.watchedPaths = [];
    staleReset.clones = [];

    saveConfig(staleReset, {
      replaceRepositoryState: true,
      beforeRepositoryStateReplace: current => cleaned.push(...current.clones.map(clone => clone.path)),
    });

    expect(cleaned).toEqual(['/new/repo']);
    expect(loadConfig()).toMatchObject({workspaceId: 2, watchedPaths: [], clones: []});
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('does not execute a binding-locked mutation for a stale device', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-config-'));
    process.env.TRACEMINI_HOME = home;
    const stale = {...loadConfig(), serverUrl: 'https://old.example', workspaceId: 1, agentId: 1, agentToken: 'old'};
    saveConfig(stale);
    saveConfig({...stale, serverUrl: 'https://new.example', agentToken: 'new'}, {replaceRepositoryState: true});
    let invoked = false;

    expect(mutateCurrentBinding(stale, () => { invoked = true; })).toBe(false);
    expect(invoked).toBe(false);
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('does not resurrect an interactive credential deletion', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-config-'));
    process.env.TRACEMINI_HOME = home;
    saveConfig({...loadConfig(), userToken: 'temporary-user-token', workspaceId: 1});
    const staleAgent = loadConfig();
    const exchanged = loadConfig();
    delete exchanged.userToken;
    exchanged.agentToken = 'installed-agent-token';
    saveConfig(exchanged);
    saveConfig(staleAgent, {preserveCurrentScalars: true});

    expect(loadConfig()).toMatchObject({agentToken: 'installed-agent-token', workspaceId: 1});
    expect(loadConfig().userToken).toBeUndefined();
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('recovers a config lock left by a dead process', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-config-'));
    process.env.TRACEMINI_HOME = home;
    fs.mkdirSync(path.join(home, 'config.lock'), {mode: 0o700});
    fs.writeFileSync(path.join(home, 'config.lock', 'owner'), '2147483647', {mode: 0o600});

    saveConfig({...loadConfig(), workspaceId: 9});

    expect(loadConfig().workspaceId).toBe(9);
    expect(fs.existsSync(path.join(home, 'config.lock'))).toBe(false);
    fs.rmSync(home, {recursive: true, force: true});
  });
});
