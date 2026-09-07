import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {publishRepositoryCandidates} from '../packages/cli/src/agent.js';
import {type Config, saveConfig} from '../packages/cli/src/config.js';

const createRepository = (root: string, name: string) => {
  const repository = path.join(root, name);
  fs.mkdirSync(repository);
  execFileSync('git', ['init'], {cwd: repository});
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/team/${name}.git`], {cwd: repository});
  return repository;
};

describe('repository discovery responsiveness', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TRACEMINI_HOME;
  });

  it('publishes bounded metadata without registering clones or installing hooks', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-discover-'));
    process.env.TRACEMINI_HOME = path.join(temporary, 'state');
    const one = createRepository(temporary, 'one');
    const two = createRepository(temporary, 'two');
    let body: any;
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ok: true, count: body.repositories.length});
    }));
    const config: Config = {
      serverUrl: 'http://tracemini.test', agentToken: 'agent-token', agentId: 4,
      workspaceId: 8, watchedPaths: [temporary, one], clones: [], reporter: 'codex', pollMs: 2000,
    };
    saveConfig(config);

    expect(await publishRepositoryCandidates(config)).toHaveLength(2);
    expect(body.repositories).toHaveLength(2);
    expect(body.repositories.map((candidate: any) => candidate.localKey).sort()).toEqual([one, two].sort());
    expect(config.clones).toEqual([]);
    expect(fs.existsSync(path.join(one, '.git', 'hooks', 'post-commit'))).toBe(false);
    expect(fs.existsSync(path.join(two, '.git', 'hooks', 'post-commit'))).toBe(false);
    fs.rmSync(temporary, {recursive: true, force: true});
  });
});
