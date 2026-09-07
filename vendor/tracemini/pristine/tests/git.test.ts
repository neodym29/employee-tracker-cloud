import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discover, inspectRepo, commitData, commitHistory, stagedData, installHooks, removeHooks, normalizeRemote, parsePrePush, confirmPush, observeRepositoryState } from '../packages/cli/src/git.js';

const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('real Git integration', () => {
  it('discovers and extracts a real repository while preserving hooks', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-git-'));
    const repo = path.join(tmp, 'nested', 'repo');
    fs.mkdirSync(repo, { recursive: true });
    run(repo, 'init'); run(repo, 'config', 'user.name', 'Test User'); run(repo, 'config', 'user.email', 'test@example.test');
    run(repo, 'remote', 'add', 'origin', 'git@example.com:Team/Project.git');
    fs.writeFileSync(path.join(repo, 'one.txt'), 'one\n'); run(repo, 'add', 'one.txt');
    expect(stagedData(repo).changedFiles).toEqual(['one.txt']);
    run(repo, 'commit', '-m', 'First real commit');
    expect(discover(tmp)).toEqual([repo]);
    expect(inspectRepo(repo)).toMatchObject({name: 'Project', normalizedRemote: 'example.com/team/project'});
    expect(commitData(repo)).toMatchObject({ message: 'First real commit', filesChanged: 1 });
    const hook = path.join(repo, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho original\n', { mode: 0o755 });
    expect(installHooks(repo)).toContain('post-commit');
    expect(fs.readFileSync(hook, 'utf8')).toContain('TraceMini managed hook');
    expect(fs.readFileSync(hook + '.tracemini-original', 'utf8')).toContain('original');
    expect(removeHooks(repo)).toContain('post-commit');
    expect(fs.readFileSync(hook, 'utf8')).toContain('original');
    expect(fs.existsSync(hook + '.tracemini-original')).toBe(false);
    expect(normalizeRemote('https://example.com/team/project.git')).toBe(normalizeRemote('git@example.com:team/project.git'));
  });

  it('uses matching parent-folder casing for a lowercase remote repository slug', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-name-'));
    const repo = path.join(tmp, 'CoachConnect', 'Project');
    fs.mkdirSync(repo, {recursive: true});
    run(repo, 'init'); run(repo, 'config', 'user.email', 'ada@example.com'); run(repo, 'config', 'user.name', 'Ada');
    run(repo, 'remote', 'add', 'origin', 'https://github.com/team/coachconnect.git');

    expect(inspectRepo(repo).name).toBe('CoachConnect');
  });

  it('continues below an invalid Git marker to find nested repositories', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-invalid-git-marker-'));
    const outer = path.join(tmp, 'outer');
    const repo = path.join(outer, 'project');
    fs.mkdirSync(path.join(outer, '.git'), {recursive: true});
    fs.mkdirSync(repo);
    run(repo, 'init');

    expect(discover(tmp)).toEqual([repo]);
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  it('imports only commits inside an initial or incremental history window', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-history-'));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    run(repo, 'init');
    run(repo, 'config', 'user.name', 'History User');
    run(repo, 'config', 'user.email', 'history@example.test');
    const commitAt = (filename: string, content: string, message: string, timestamp: string) => {
      fs.writeFileSync(path.join(repo, filename), content);
      run(repo, 'add', filename);
      execFileSync('git', ['commit', '-m', message], {cwd: repo, encoding: 'utf8', env: {...process.env, GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp}});
    };
    commitAt('old.txt', 'old\n', 'Outside window', '2026-04-01T12:00:00Z');
    commitAt('initial.txt', 'one\n', 'Initial import', '2026-08-01T12:00:00Z');
    commitAt('new.txt', 'one\ntwo\n', 'Incremental import', '2026-08-20T12:00:00Z');

    expect(commitHistory(repo, '2026-06-01T00:00:00Z', '2026-08-10T00:00:00Z')).toMatchObject([
      {message: 'Initial import', commitTimestamp: '2026-08-01T12:00:00+00:00', filesChanged: 1, insertions: 1, deletions: 0},
    ]);
    expect(commitHistory(repo, '2026-08-10T00:00:00Z', '2026-08-24T00:00:00Z')).toMatchObject([
      {message: 'Incremental import', commitTimestamp: '2026-08-20T12:00:00+00:00', filesChanged: 1, insertions: 2, deletions: 0},
    ]);
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  it('captures pre-push intent and confirms only the advertised ref on a real bare remote', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-push-'));
    const bare = path.join(tmp, 'remote.git');
    const repo = path.join(tmp, 'repo');
    run(tmp, 'init', '--bare', bare);
    run(tmp, 'clone', bare, repo);
    run(repo, 'config', 'user.name', 'Test User');
    run(repo, 'config', 'user.email', 'test@example.test');
    fs.writeFileSync(path.join(repo, 'push.txt'), 'push\n');
    run(repo, 'add', 'push.txt');
    run(repo, 'commit', '-m', 'Push me');
    const sha = run(repo, 'rev-parse', 'HEAD').trim();
    const intent = parsePrePush('origin', bare, `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`)[0];
    expect(intent).toMatchObject({remoteName: 'origin', ref: 'refs/heads/main', expectedSha: sha});
    expect(confirmPush(intent)).toMatchObject({status: 'unconfirmed'});
    run(repo, 'push', 'origin', 'HEAD:refs/heads/main');
    expect(confirmPush(intent)).toEqual({status: 'confirmed', observedSha: sha});
  });

  it('infers an update only when persisted remote and local HEAD move together', () => {
    expect(observeRepositoryState({branch: 'main', headSha: 'a', remoteHeadSha: 'a'}, {branch: 'main', headSha: 'b', remoteHeadSha: 'a'}).event).toBeUndefined();
    expect(observeRepositoryState({branch: 'main', headSha: 'a', remoteHeadSha: 'a'}, {branch: 'main', headSha: 'b', remoteHeadSha: 'b'}).event).toBe('pull');
    expect(observeRepositoryState({branch: 'main', headSha: 'a', remoteHeadSha: 'a'}, {branch: 'main', headSha: 'b', remoteHeadSha: 'b', headAction: 'commit: local work'}).event).toBeUndefined();
    expect(observeRepositoryState({branch: 'main', headSha: 'a', remoteHeadSha: 'a'}, {branch: 'topic', headSha: 'c', remoteHeadSha: 'c'}).event).toBeUndefined();
  });
});
