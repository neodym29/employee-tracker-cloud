import {describe, expect, it, vi} from 'vitest';
import {Readable, Writable} from 'node:stream';
import type {Config} from '../packages/cli/src/config.js';
import {normalizeServerUrl, previousDeviceTokenForServer, rebindDeviceConfig, rebindWorkspaceConfig} from '../packages/cli/src/pairing.js';
import {restartStartup, stopStartup, withStartupRestart} from '../packages/cli/src/install.js';
import {helpText, normalizeWatchPath, promptForWatchPaths} from '../packages/cli/src/setup.js';

const existing = (): Config => ({
  serverUrl: 'https://old.example.test',
  userToken: 'old-user',
  agentToken: 'old-device',
  agentId: 9,
  workspaceId: 3,
  watchedPaths: ['/home/ali', '/work/project'],
  clones: [{path: '/work/project', repositoryId: 44, normalizedRemote: 'example/repo', name: 'repo'}],
  reporter: 'hermes',
  pollMs: 5000,
});

describe('CLI device re-pairing', () => {
  it('normalizes guided watch paths and exposes the complete help command', () => {
    expect(normalizeWatchPath('$HOME', process.cwd())).toBe(process.cwd());
    expect(normalizeWatchPath(`"${process.cwd()}"`)).toBe(process.cwd());
    expect(normalizeWatchPath(new URL(`file://${process.cwd()}`).href)).toBe(process.cwd());
    expect(() => normalizeWatchPath('relative/path')).toThrow(/absolute path/);
    expect(helpText).toContain('tracemini watch "$HOME/projects"');
    expect(helpText).toContain('tracemini --help');
  });

  it('consumes every guided answer from piped installer input', async () => {
    let output = '';
    const sink = new Writable({write(chunk, _encoding, done) { output += chunk.toString(); done(); }});
    await expect(promptForWatchPaths(Readable.from([`${process.cwd()}\nn\n`]) as any, sink as any)).resolves.toEqual([process.cwd()]);
    expect(output).toContain('Add another watch path?');
  });

  it('keeps local preferences but clears repository state and installs the new credential', () => {
    const rebound = rebindDeviceConfig(existing(), 'https://new.example.test', {
      agentToken: 'new-device', agentId: 10, workspaceId: 8,
    });

    expect(rebound).toMatchObject({
      serverUrl: 'https://new.example.test',
      agentToken: 'new-device',
      agentId: 10,
      workspaceId: 8,
      watchedPaths: [],
      clones: [],
      reporter: 'hermes',
      pollMs: 5000,
    });
    expect(rebound).not.toHaveProperty('userToken');
  });

  it('preserves watched roots and clones when only the preferred workspace changes', () => {
    expect(rebindWorkspaceConfig(existing(), 8)).toMatchObject({workspaceId: 8, watchedPaths: ['/home/ali', '/work/project'], clones: [{path: '/work/project'}], agentToken: 'old-device'});
    expect(rebindWorkspaceConfig(existing(), 3)).toMatchObject({workspaceId: 3, watchedPaths: ['/home/ali', '/work/project']});
  });

  it('preserves repository state when the same account device rotates its token', () => {
    const rebound = rebindDeviceConfig(existing(), 'https://old.example.test', {
      agentToken: 'rotated-device', agentId: 9, workspaceId: 8,
    });

    expect(rebound).toMatchObject({workspaceId: 8, watchedPaths: ['/home/ali', '/work/project'], clones: [{path: '/work/project'}], agentToken: 'rotated-device'});
  });

  it('restarts the existing Linux user service after credentials change', () => {
    const execute = vi.fn();
    restartStartup('linux', execute as any);
    expect(execute).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'tracemini.service'], {stdio: 'ignore'});
    expect(() => restartStartup('win32', execute as any)).toThrow(/Linux only/);
  });

  it('restarts the service when credential sync fails', async () => {
    const stop = vi.fn();
    const restart = vi.fn();
    const failure = new Error('install token expired');

    await expect(withStartupRestart(async () => { throw failure; }, stop, restart)).rejects.toBe(failure);
    expect(stop).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledOnce();
  });

  it('returns the sync result after restarting the service', async () => {
    const calls: string[] = [];
    await expect(withStartupRestart(async () => { calls.push('sync'); return {agentId: 7}; }, () => calls.push('stop'), () => calls.push('restart')))
      .resolves.toEqual({agentId: 7});
    expect(calls).toEqual(['stop', 'sync', 'restart']);
  });

  it('upgrades hosted HTTP URLs to HTTPS without changing local development URLs', () => {
    expect(normalizeServerUrl('http://tracemini.vercel.app')).toBe('https://tracemini.vercel.app');
    expect(normalizeServerUrl('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001');
    expect(previousDeviceTokenForServer(existing(), 'https://old.example.test')).toBe('old-device');
    expect(previousDeviceTokenForServer(existing(), 'https://new.example.test')).toBeUndefined();
  });

  it('cancels syncing when an active service cannot be stopped', () => {
    const active = vi.fn((_command: string, args: string[]) => {
      if (args.includes('stop')) throw new Error('stop failed');
      return undefined;
    });
    expect(() => stopStartup('linux', active as any)).toThrow(/cancelled safely/);

    const inactive = vi.fn(() => { throw new Error('not active'); });
    expect(() => stopStartup('linux', inactive as any)).not.toThrow();
  });
});
