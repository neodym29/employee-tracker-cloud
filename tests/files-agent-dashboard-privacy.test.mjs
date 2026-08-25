import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function loadDashboard(query) {
  const javascript = ts.transpileModule(read('lib/files-agent-dashboard.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === './db') return { getPool: () => ({ query }) };
      if (specifier === './files-agent-daily-summary') {
        return { privacySafeProjectLabel: () => 'safe-project' };
      }
      throw new Error(`unexpected import: ${specifier}`);
    },
    Date,
  });
  return module.exports;
}

const storedSummary = {
  source: 'files_agent_events',
  bounds: { date: '2026-08-11', timezone: 'Asia/Karachi', start: '2026-08-10T19:00:00.000Z', end: '2026-08-11T19:00:00.000Z' },
  totals: { events: 1, changedPaths: 1, users: 1, devices: 1 },
  users: [], narrative: 'durably stored', privacy: 'minimized',
};

test('dashboard consumes the latest durable tenant summary and never live-recomputes it', async () => {
  const calls = [];
  const { readFilesAgentDashboard } = loadDashboard(async (text, values) => {
    calls.push({ text, values });
    if (/files_agent_daily_summaries/i.test(text)) return { rows: [{ summary: storedSummary, generated_at: '2026-08-12T01:02:03.000Z' }] };
    return { rows: [] };
  });
  const data = await readFilesAgentDashboard('42');
  assert.equal(data.dailySummary.status, 'generated');
  assert.equal(data.dailySummary.generatedAt, '2026-08-12T01:02:03.000Z');
  assert.equal(data.dailySummary.summary.narrative, 'durably stored');
  const summaryCall = calls.find(({ text }) => /files_agent_daily_summaries/i.test(text));
  assert.match(summaryCall.text, /company_id\s*=\s*\$1/i);
  assert.match(summaryCall.text, /order by summary_date desc/i);
  assert.deepEqual(Array.from(summaryCall.values), ['42']);
  assert.equal(calls.some(({ text }) => /from files_agent_events[\s\S]*group by/i.test(text)), false, 'must not run live summary aggregation');
});

test('dashboard returns an explicit not-generated state when no durable summary exists', async () => {
  const { readFilesAgentDashboard } = loadDashboard(async () => ({ rows: [] }));
  const data = await readFilesAgentDashboard('42');
  assert.deepEqual(JSON.parse(JSON.stringify(data.dailySummary)), {
    status: 'not_generated', generatedAt: null, summary: null,
  });
});

test('browser dashboard payload excludes direct identifiers, raw device details, run ids, and full paths', async () => {
  const queries = [];
  const { readFilesAgentDashboard } = loadDashboard(async (text) => {
    queries.push(text);
    if (/from files_agent_devices d/i.test(text) && !/files_agent_events/i.test(text)) return { rows: [
      { id: '9', user_id: '7', last_seen_at: '2026-08-12T01:00:00Z', revoked_at: null },
    ] };
    if (/from files_agent_events e/i.test(text)) return { rows: [
      { user_id: '7', device_id: '9', action: 'write', path: '/home/alice/work/secret/src/token.ts', agent: 'codex', captured_at: '2026-08-12T01:00:00Z' },
    ] };
    return { rows: [{ summary: storedSummary, generated_at: '2026-08-12T01:02:03Z' }] };
  });
  const data = await readFilesAgentDashboard('42');
  assert.deepEqual(JSON.parse(JSON.stringify(data.devices[0])), {
    owner: 'Employee 7', device: 'Device 1', lastSeenAt: '2026-08-12T01:00:00.000Z', revokedAt: null,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(data.events[0])), {
    owner: 'Employee 7', device: 'Device 1', action: 'write', project: 'safe-project', agent: 'codex', capturedAt: '2026-08-12T01:00:00.000Z',
  });
  const serialized = JSON.stringify(data);
  for (const secret of ['alice@example.com', 'alice-host', 'Laptop', '1.2.3', 'run-secret', '/home/alice', 'token.ts']) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  const eventQuery = queries.find((text) => /from files_agent_events e/i.test(text));
  assert.match(eventQuery, /payload->>'agent'\s+in\s*\('hermes','codex','claude'\)/i);
  assert.match(eventQuery, /e\.action\s+in\s*\(/i);
  assert.doesNotMatch(eventQuery, /email|hostname|device_label|agent_version|run_id/i);
});

test('dashboard UI prioritizes recent file changes and contains no direct-identifier fields', () => {
  const client = read('app/dashboard/DashboardClient.tsx');
  const page = read('app/dashboard/page.tsx');
  assert.match(client, /Recent changes/);
  assert.match(client, /Connected agents/);
  assert.match(client, /dailySummary/);
  assert.doesNotMatch(client, /ownerEmail|hostname|agentVersion|runId|event\.path/);
  assert.doesNotMatch(page, /failure\.message|String\(failure\)/);
});
