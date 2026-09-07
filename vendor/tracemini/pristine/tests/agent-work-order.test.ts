import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {contextPrompt, tick} from '../packages/cli/src/agent.js';
import {type Config} from '../packages/cli/src/config.js';

describe('agent service work ordering', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TRACEMINI_HOME;
  });

  it('fetches reports, scans, selections, and pushes in one idle control invocation', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-work-order-'));
    process.env.TRACEMINI_HOME = temporary;
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      paths.push(pathname);
      if (pathname === '/api/agents/sync') return Response.json({workspaceIds: [8], jobs: [], refreshRequests: [], repositorySelections: [], pushes: []});
      return Response.json({error: `unexpected ${pathname}`}, {status: 404});
    }));
    const config: Config = {
      serverUrl: 'http://tracemini.test',
      agentToken: 'agent-token',
      workspaceId: 8,
      watchedPaths: [],
      clones: [],
      reporter: 'codex',
      pollMs: 2000,
    };

    await tick(config, new Map());

    expect(paths).toEqual(['/api/agents/sync']);
    fs.rmSync(temporary, {recursive: true, force: true});
  });

  it('does not put another member local-device path into a Manager report prompt', () => {
    const prompt = contextPrompt({
      job: {user_id: 1, start_date: '2026-08-26', end_date: '2026-08-26', timezone: 'UTC', format: 'summary'},
      events: [
        {user_id: 2, user_name: 'Developer', repository_name: '/opaque/QZ7M4N8891/private-project', normalized_remote: 'local-device-7//home/developer/private/project', type: 'push', occurred_at: '2026-08-26T10:00:00.000Z', data: {message: 'Work completed; EACCES:/opaque/QZ7M4N8891/private; UNC \\\\HOST\\AliHome\\repo', sourceCode: 'CANARY /opaque/QZ7M4N8891/source.ts', remoteUrl: 'file:///home/developer/private/project', localKey: '/home/developer/private/project'}},
        ...['/CANARY_POSIX/home/alice/repo', 'C:\\CANARY_DRIVE\\Users\\Alice\\repo', '\\\\CANARY_UNC\\AliceHome\\repo', 'local:/CANARY_LOCAL/home/alice/repo', 'local-device-9:/CANARY_DEVICE/home/alice/repo'].map((normalized_remote, index) => ({user_id: 2, user_name: 'Developer', repository_name: 'legacy-private', normalized_remote, type: 'commit', occurred_at: `2026-08-26T1${index}:00:00.000Z`, data: {message: 'Legacy private repository activity'}})),
      ],
    }, []);

    expect(prompt).toContain('Repository: private local repository');
    expect(prompt).toContain('## Evidence: private-project');
    expect(prompt).not.toContain('/home/developer');
    expect(prompt).not.toContain('local-device-7');
    expect(prompt).not.toContain('/opaque/');
    expect(prompt).not.toContain('HOST\\AliHome');
    for (const canary of ['CANARY_POSIX', 'CANARY_DRIVE', 'CANARY_UNC', 'CANARY_LOCAL', 'CANARY_DEVICE']) expect(prompt).not.toContain(canary);
    expect(prompt).not.toContain('CANARY /opaque');
  });
});
