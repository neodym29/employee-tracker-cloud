import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {contextPrompt} from '../packages/cli/src/agent.js';

let temporary = '';
afterEach(() => { if (temporary) fs.rmSync(temporary, {recursive: true, force: true}); });

describe('evidence-rich reports', () => {
  it('grounds contribution-focused reports and only includes source patches after explicit consent', () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-report-evidence-'));
    execFileSync('git', ['init', '-q'], {cwd: temporary});
    execFileSync('git', ['config', 'user.email', 'report@example.test'], {cwd: temporary});
    execFileSync('git', ['config', 'user.name', 'Report Test'], {cwd: temporary});
    fs.writeFileSync(path.join(temporary, 'feature.ts'), 'export const featureFlag = true;\n');
    execFileSync('git', ['add', '.'], {cwd: temporary});
    execFileSync('git', ['commit', '-qm', 'feat: add precise report evidence'], {cwd: temporary});
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: temporary, encoding: 'utf8'}).trim();
    const event = {repository_name: 'sample', normalized_remote: 'example/sample', occurred_at: '2026-08-24T10:00:00Z', type: 'commit', data: {commitSha: sha, message: 'feat: add precise report evidence', changedFiles: ['feature.ts'], filesChanged: 1, insertions: 1, deletions: 0}};
    const clones: any = [{path: temporary, normalizedRemote: 'example/sample'}];

    const summaryOnly = contextPrompt({job: {start_date: '2026-08-24', end_date: '2026-08-24', timezone: 'Asia/Karachi', include_diff: false}, events: [event]}, clones);
    expect(summaryOnly).toContain(sha.slice(0, 12));
    expect(summaryOnly).toContain('feat: add precise report evidence');
    expect(summaryOnly).not.toContain('+export const featureFlag = true;');

    const detailed = contextPrompt({job: {start_date: '2026-08-24', end_date: '2026-08-24', timezone: 'UTC', include_diff: true}, events: [event]}, clones);
    expect(detailed).toContain('+export const featureFlag = true;');
    expect(detailed).toContain('Synthesize related work into meaningful contributions');
    expect(detailed).toContain('Do not structure the report as a commit-by-commit chronology');
  });

  it('redacts sensitive values from added and unchanged diff lines before generation', () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-report-redaction-'));
    execFileSync('git', ['init', '-q'], {cwd: temporary});
    execFileSync('git', ['config', 'user.email', 'report@example.test'], {cwd: temporary});
    execFileSync('git', ['config', 'user.name', 'Report Test'], {cwd: temporary});
    fs.writeFileSync(path.join(temporary, 'config.ts'), [
      'const password = "context-password-value";',
      'const endpoint = "postgres://db-user:***@example.test/app";',
      'const passwd = "context-passwd-value";',
      'export const featureFlag = false;',
      '',
    ].join('\n'));
    execFileSync('git', ['add', '.'], {cwd: temporary});
    execFileSync('git', ['commit', '-qm', 'test: establish nearby sensitive context'], {cwd: temporary});
    fs.writeFileSync(path.join(temporary, 'config.ts'), [
      'const password = "context-password-value";',
      'const endpoint = "postgres://db-user:db-password@example.test/app";',
      'const headers = {"Authorization": "Bearer bearer-secret-value"};',
      'const config = {"apiKey": "quoted-api-secret-value"};',
      'const pwd = "added-pwd-value";',
      'export const featureFlag = true;',
      '',
    ].join('\n'));
    execFileSync('git', ['add', '.'], {cwd: temporary});
    execFileSync('git', ['commit', '-qm', 'feat: update configuration behavior'], {cwd: temporary});
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: temporary, encoding: 'utf8'}).trim();
    const event = {repository_name: 'sample', normalized_remote: 'example/sample', occurred_at: '2026-08-24T10:00:00Z', type: 'commit', data: {commitSha: sha, message: 'feat: update configuration behavior', password: 'event-password-value', token: 'generic-token-value', authToken: 'auth-token-value', nested: {token: 'nested-token-value'}, endpoint: 'postgres://event-user:event-password@example.test/app'}};

    const prompt = contextPrompt({job: {start_date: '2026-08-24', end_date: '2026-08-24', timezone: 'UTC', include_diff: true}, events: [event]}, [{path: temporary, normalizedRemote: 'example/sample'}] as any);
    for (const secret of ['context-password-value', 'db-password', 'context-passwd-value', 'added-pwd-value', 'bearer-secret-value', 'quoted-api-secret-value', 'event-password-value', 'event-password', 'generic-token-value', 'auth-token-value', 'nested-token-value']) expect(prompt).not.toContain(secret);
    expect(prompt).toContain('[REDACTED SENSITIVE VALUE]');
  });

  it('applies redaction at the final prompt boundary for every interpolated field', () => {
    const prompt = contextPrompt({
      job: {
        start_date: '2026-08-24',
        end_date: '2026-08-24',
        timezone: 'UTC',
        include_diff: false,
        custom_prompt: 'password:\nCUSTOM_PROMPT_SECRET\namqp://user:AMQP_SECRET@example.test/vhost\nssh://user:SSH_SECRET@example.test/repo',
      },
      events: [{
        repository_name: 'accessKeyId=REPOSITORY_NAME_SECRET',
        normalized_remote: 'example/safe',
        occurred_at: '2026-08-24T10:00:00Z',
        type: 'consumerKey=EVENT_TYPE_SECRET',
        data: {message: 'safe contribution metadata', authToken: 'AUTH_TOKEN_SECRET', nested: {safe: 'SAFE_NESTED', accessKey: 'ACCESS_KEY_SECRET'}, safe: 'SAFE_SIBLING'},
      }],
    }, [{path: '/tmp/password=LOCAL_PATH_SECRET', normalizedRemote: 'example/safe'}] as any);

    for (const secret of ['CUSTOM_PROMPT_SECRET', 'AMQP_SECRET', 'SSH_SECRET', 'REPOSITORY_NAME_SECRET', 'LOCAL_PATH_SECRET', 'EVENT_TYPE_SECRET', 'AUTH_TOKEN_SECRET', 'ACCESS_KEY_SECRET']) expect(prompt).not.toContain(secret);
    for (const safe of ['safe contribution metadata', 'SAFE_NESTED', 'SAFE_SIBLING']) expect(prompt).toContain(safe);
  });
});
