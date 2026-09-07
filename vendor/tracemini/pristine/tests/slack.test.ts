import {afterEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {chunkSlackMrkdwn, markdownToSlackMrkdwn, sendSlackReport, slackReportRange} from '../apps/server/src/slack.js';

afterEach(() => vi.unstubAllGlobals());

describe('Slack report notifications', () => {
  it('loads the root local environment for both server commands', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../apps/server/package.json'), 'utf8'));
    expect(packageJson.scripts.dev).toContain('--env-file-if-exists=../../.env.local');
    expect(packageJson.scripts.start).toContain('--env-file-if-exists=../../.env.local');
  });

  it('converts report Markdown to Slack mrkdwn', () => {
    const markdown = '# Delivery\n\n**Shipped** [reports](https://example.test/reports).\n\n- First item\n- [x] Complete\n\n| Area | Result |\n| --- | --- |\n| API | Ready |\n\n```ts\nconst value = 1;\n```';
    expect(markdownToSlackMrkdwn(markdown)).toBe('*Delivery*\n\n*Shipped* <https://example.test/reports|reports>.\n\n• First item\n☑ Complete\n\n```\n| Area | Result |\n| --- | --- |\n| API | Ready |\n```\n\n```\nconst value = 1;\n```');
  });

  it('formats a single report date once and a multi-day range twice', () => {
    expect(slackReportRange('2026-08-26', '2026-08-26')).toBe('August 26, 2026');
    expect(slackReportRange('2026-08-20', '2026-08-26')).toBe('August 20, 2026 – August 26, 2026');
  });

  it('keeps long mrkdwn blocks within Slack limits', () => {
    const chunks = chunkSlackMrkdwn(`Intro\n\`\`\`\n${'x'.repeat(6_000)}\n\`\`\``);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.length <= 2_900)).toBe(true);
  });

  it('sends the complete converted report with workspace context and no TraceMini link', async () => {
    const post = vi.fn().mockResolvedValue({ok: true});
    vi.stubGlobal('fetch', post);
    await sendSlackReport('https://hooks.slack.test/report', {
      id: 42, workspaceId: 7, workspaceName: 'Trace Mini', name: 'Daily delivery',
      startDate: '2026-08-26', endDate: '2026-08-26', scope: 'workspace',
      markdown: '# Work completed\n\n**Shipped** Slack reports.\n\n- Preserved the entire report.',
    });

    const [url, request] = post.mock.calls[0];
    const payload = JSON.parse(request.body);
    expect(url).toBe('https://hooks.slack.test/report');
    expect(payload.text).toBe('Daily delivery — Trace Mini — August 26, 2026');
    expect(payload.blocks).toEqual([
      {type: 'header', text: {type: 'plain_text', text: 'Daily delivery'}},
      {type: 'context', elements: [{type: 'mrkdwn', text: '*Workspace:* Trace Mini  •  *Range:* August 26, 2026  •  *Type:* Workspace report'}]},
      {type: 'divider'},
      {type: 'section', text: {type: 'mrkdwn', text: '*Work completed*\n\n*Shipped* Slack reports.\n\n• Preserved the entire report.'}},
    ]);
  });
});
