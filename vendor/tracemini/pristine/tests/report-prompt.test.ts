import {describe, expect, it} from 'vitest';
import {contextPrompt} from '../packages/cli/src/agent.js';

describe('engineering report prompt', () => {
  it('synthesizes engineering contributions and applies regeneration guidance', () => {
    const prompt = contextPrompt({
      job: {
        start_date: '2026-08-01',
        end_date: '2026-08-25',
        coalesced_runs: 2,
        custom_prompt: 'Use an executive summary followed by project outcomes.',
      },
      events: [{
        normalized_remote: 'github.com/team/product',
        repository_name: 'Product',
        occurred_at: '2026-08-20T10:00:00.000Z',
        type: 'commit',
        data: {commitSha: 'missing-locally', message: 'Add workspace reporting'},
      }],
    }, []);

    expect(prompt).toContain('engineering contributions');
    expect(prompt).toContain('Do not structure the report as a commit-by-commit chronology');
    expect(prompt).toContain('technical decisions');
    expect(prompt).toContain('Use an executive summary followed by project outcomes.');
    expect(prompt).toContain('Use only the supplied Git evidence');
    expect(prompt).toContain('2 older scheduled occurrence(s) were coalesced');
    expect(prompt).toContain('Wrap every repository name in inline code backticks');
    expect(prompt).toContain('for example, `TraceMini`');
    expect(prompt).toContain('Use bold text sparingly');
    expect(prompt).toContain('Do not use tables');
  });

  it('uses visibly different structures for summary and detailed reports', () => {
    const base = {start_date: '2026-08-01', end_date: '2026-08-25', timezone: 'UTC'};
    const events = [{normalized_remote: 'github.com/team/product', repository_name: 'product', user_name: 'Ali', type: 'commit', occurred_at: '2026-08-25T10:00:00Z', data: {message: 'Ship feature'}}];
    const summary = contextPrompt({job: {...base, format: 'summary'}, events}, []);
    const detailed = contextPrompt({job: {...base, format: 'detailed'}, events}, []);

    expect(summary).toContain('concise bullet points');
    expect(summary).toContain('brief summary');
    expect(detailed).toContain('detailed narrative');
    expect(detailed).toContain('technical decisions');
    expect(detailed).toContain('Contributor: Ali');
  });

  it('requires workspace reports to cover every contributor without out-of-window commentary', () => {
    const prompt = contextPrompt({
      job: {user_id: 1, report_scope: 'workspace', start_date: '2026-08-25', end_date: '2026-08-26', timezone: 'Asia/Karachi', format: 'summary'},
      events: [
        {user_id: 1, user_name: 'Manager', repository_name: 'tracemini', type: 'commit', occurred_at: '2026-08-25T10:00:00Z', data: {message: 'Manage release'}},
        {user_id: 2, user_name: 'Developer', repository_name: 'tracemini', type: 'commit', occurred_at: '2026-08-25T11:00:00Z', data: {message: 'Ship feature'}},
      ],
    }, []);

    expect(prompt).toContain('whole-workspace');
    expect(prompt).toContain('Contributors with qualifying evidence: Manager, Developer');
    expect(prompt).toContain('section for each contributor');
    expect(prompt).toContain('do not add "no qualifying contribution" commentary');
    expect(prompt).toContain('do not invent clock-time boundaries');
  });

  it('uses engineer names instead of TraceMini account usernames', () => {
    const prompt = contextPrompt({
      job: {user_id: 1, report_scope: 'workspace', start_date: '2026-08-26', end_date: '2026-08-26'},
      events: [
        {user_id: 1, user_name: 'murtaza', repository_name: 'tracemini', type: 'commit', occurred_at: '2026-08-26T10:00:00Z', data: {}},
        {user_id: 2, user_name: 'ali', repository_name: 'tracemini', type: 'commit', occurred_at: '2026-08-26T11:00:00Z', data: {}},
        {user_id: 3, user_name: 'UwU', repository_name: 'tracemini', type: 'commit', occurred_at: '2026-08-26T12:00:00Z', data: {}},
        {user_id: 4, user_name: 'Jerry', repository_name: 'tracemini', type: 'commit', occurred_at: '2026-08-26T13:00:00Z', data: {}},
      ],
    }, []);

    expect(prompt).toContain('Contributors with qualifying evidence: Murtaza, Ali, Ashar, Ibrahim');
    expect(prompt).toContain('Contributor: Ashar');
    expect(prompt).toContain('Contributor: Ibrahim');
    expect(prompt).not.toContain('UwU');
    expect(prompt).not.toContain('Jerry');

    const personalPrompt = contextPrompt({
      job: {user_id: 3, start_date: '2026-08-26', end_date: '2026-08-26'},
      events: [{user_id: 3, user_name: 'UwU', repository_name: 'tracemini', type: 'commit', occurred_at: '2026-08-26T12:00:00Z', data: {authorName: 'UwU'}}],
    }, []);
    expect(personalPrompt).toContain('"authorName": "Ashar"');
    expect(personalPrompt).not.toContain('UwU');
  });
});
