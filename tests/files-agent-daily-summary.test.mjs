import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function loadSummary() {
  const source = read('lib/files-agent-daily-summary.ts');
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === './db') return { getPool: () => { throw new Error('inject a query client in tests'); } };
      throw new Error(`unexpected import: ${specifier}`);
    },
    Date,
    Intl,
    console,
  });
  return module.exports;
}

test('Karachi day bounds are explicit, exact, and default to the previous local day', () => {
  const { karachiDayBounds } = loadSummary();
  assert.deepEqual(JSON.parse(JSON.stringify(karachiDayBounds('2026-08-12'))), {
    date: '2026-08-12',
    timezone: 'Asia/Karachi',
    start: '2026-08-11T19:00:00.000Z',
    end: '2026-08-12T19:00:00.000Z',
  });
  assert.equal(karachiDayBounds(undefined, new Date('2026-08-12T20:30:00Z')).date, '2026-08-12');
  assert.throws(() => karachiDayBounds('2026-02-30'), /valid YYYY-MM-DD/);
});

test('summary query is tenant and half-open-day scoped and reads only files-agent telemetry', async () => {
  const { buildFilesAgentDailySummary } = loadSummary();
  let captured;
  const queryable = {
    async query(text, values) {
      captured = { text, values };
      return { rows: [] };
    },
  };
  const result = await buildFilesAgentDailySummary('42', '2026-08-12', queryable);
  assert.match(captured.text, /from files_agent_events e/i);
  assert.match(captured.text, /e\.company_id=\$1/);
  assert.match(captured.text, /e\.captured_at >= \$2::timestamptz/);
  assert.match(captured.text, /e\.captured_at < \$3::timestamptz/);
  assert.match(captured.text, /sum\s*\(\s*\(e\.payload->>'count'\)::(?:bigint|numeric)\s*\)/i);
  assert.doesNotMatch(captured.text, /count\s*\(\s*\*\s*\)/i);
  for (const prohibited of ['activity_events', 'activity_screenshots', 'screenshot', 'click', 'browser', 'keyboard', 'clipboard', 'audio', 'process', 'window_title']) {
    assert.doesNotMatch(captured.text, new RegExp(prohibited, 'i'));
  }
  assert.deepEqual(Array.from(captured.values), ['42', result.bounds.start, result.bounds.end]);
  assert.equal(result.source, 'files_agent_events');
  assert.equal(result.totals.events, 0);
});

test('one stored event row contributes its validated payload count and zero-count rows are ignored', async () => {
  const { buildFilesAgentDailySummary } = loadSummary();
  const queryable = { async query(text) {
    assert.match(text, /having\s+sum\s*\(\s*\(e\.payload->>'count'\)::(?:bigint|numeric)\s*\)\s*>\s*0/i);
    return { rows: [
      { user_id: '7', employee_email: 'alice@example.com', device_id: '9', device_label: 'Laptop', action: 'write', path: '/work/acme/a.ts', agent: 'codex', event_count: '8' },
    ] };
  } };
  const summary = await buildFilesAgentDailySummary('42', '2026-08-12', queryable);
  assert.equal(summary.totals.events, 8);
  assert.equal(summary.users[0].events, 8);
});

test('boss-readable summary aggregates users/devices, actions, paths, agents and private project labels', async () => {
  const { buildFilesAgentDailySummary } = loadSummary();
  const queryable = { async query() { return { rows: [
    { user_id: '7', employee_email: 'alice@example.com', device_id: '9', device_label: 'Laptop', hostname: 'alice-host', action: 'write', path: '/home/alice/work/acme/src/a.ts', agent: 'codex', event_count: '3' },
    { user_id: '7', employee_email: 'alice@example.com', device_id: '9', device_label: 'Laptop', hostname: 'alice-host', action: 'create', path: '/home/alice/work/acme/src/b.ts', agent: 'claude', event_count: '1' },
    { user_id: '7', employee_email: 'alice@example.com', device_id: '10', device_label: null, hostname: 'buildbox', action: 'write', path: 'C:\\Users\\Alice\\projects\\widget\\README.md', agent: 'codex', event_count: '2' },
  ] }; } };
  const summary = await buildFilesAgentDailySummary('42', '2026-08-12', queryable);
  assert.deepEqual(JSON.parse(JSON.stringify(summary.totals)), { events: 6, changedPaths: 3, users: 1, devices: 2 });
  assert.equal(summary.users[0].events, 6);
  assert.deepEqual(JSON.parse(JSON.stringify(summary.users[0].actions)), { write: 5, create: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(summary.users[0].agents)), { codex: 5, claude: 1 });
  assert.equal(summary.users[0].devices.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(summary.users[0].topProjects)), [
    { label: 'acme', events: 4 },
    { label: 'widget', events: 2 },
  ]);
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /\/home\/alice|C:\\\\Users|src\/a\.ts|README\.md/);
  assert.match(summary.narrative, /Alice/);
  assert.match(summary.narrative, /6 file actions across 3 changed paths/);
});

test('durable delivery upserts one sanitized tenant/date row and applies bounded retention', async () => {
  const { persistFilesAgentDailySummary } = loadSummary();
  const calls = [];
  const queryable = { async query(text, values) {
    calls.push({ text, values });
    if (/from files_agent_events e/i.test(text)) return { rows: [
      { user_id: '7', employee_email: 'alice+secret@example.com', device_id: '9', device_label: '/home/alice/password.txt', action: 'write', path: '/home/alice/work/client-secret/src/token.txt', agent: 'Bearer super-secret', event_count: '2' },
    ] };
    return { rows: [], rowCount: 1 };
  } };
  const stored = await persistFilesAgentDailySummary('42', '2026-08-12', queryable, 30);
  const upsert = calls.find((call) => /insert into files_agent_daily_summaries/i.test(call.text));
  const cleanup = calls.find((call) => /delete from files_agent_daily_summaries/i.test(call.text));
  assert.ok(upsert, 'summary must be durably upserted');
  assert.match(upsert.text, /on conflict\s*\(company_id,summary_date\).*do update/is);
  assert.equal(upsert.values[0], '42');
  assert.equal(upsert.values[1], '2026-08-12');
  assert.equal(cleanup.values[0], '42');
  assert.equal(cleanup.values[1], 30);
  const serialized = JSON.stringify(stored);
  assert.doesNotMatch(serialized, /alice|example\.com|password|client-secret|super-secret|Bearer|\/home\//i);
  assert.equal(stored.schemaVersion, 1);
  assert.ok(calls.some((call) => /pg_advisory.*lock/i.test(call.text)), 'upsert must coordinate with wipe');
  assert.ok(calls.some((call) => /telemetry_paused/i.test(call.text)), 'upsert must stop while telemetry is paused');
});

test('stored summary reads are tenant scoped and latest-by-default', async () => {
  const { readFilesAgentDailySummary } = loadSummary();
  let captured;
  const queryable = { async query(text, values) {
    captured = { text, values };
    return { rows: [{ summary: {
      schemaVersion: 1,
      source: 'files_agent_events',
      bounds: { date: '2026-08-12', timezone: 'Asia/Karachi', start: '2026-08-11T19:00:00.000Z', end: '2026-08-12T19:00:00.000Z' },
      totals: { events: 0, changedPaths: 0, users: 0, devices: 0 },
      users: [], narrative: 'stored', privacy: 'counts only',
    } }] };
  } };
  const latest = await readFilesAgentDailySummary('42', undefined, queryable);
  assert.equal(latest.narrative, 'stored');
  assert.match(captured.text, /from files_agent_daily_summaries/i);
  assert.match(captured.text, /company_id=\$1/);
  assert.match(captured.text, /order by summary_date desc/i);
  assert.deepEqual(Array.from(captured.values), ['42']);
  await readFilesAgentDailySummary('42', '2026-08-12', queryable);
  assert.match(captured.text, /summary_date=\$2::date/);
  assert.deepEqual(Array.from(captured.values), ['42', '2026-08-12']);
});

test('stored summaries are validated at runtime and malformed or old-version JSON is rejected', async () => {
  const { readFilesAgentDailySummary } = loadSummary();
  for (const summary of [
    { source: 'files_agent_events', narrative: 'legacy without version' },
    { schemaVersion: 1, source: 'files_agent_events', narrative: 123 },
  ]) {
    const queryable = { async query(text) {
      if (/select summary/i.test(text)) return { rows: [{ summary }] };
      return { rows: [] };
    } };
    await assert.rejects(readFilesAgentDailySummary('42', undefined, queryable), /invalid stored daily summary/i);
  }
});

test('daily endpoint persists cron delivery with per-tenant isolation and lets admins read stored rows', () => {
  const route = read('app/api/files-agent/daily-summary/route.ts');
  assert.match(route, /authorization.*Bearer.*CRON_SECRET/is);
  assert.match(route, /currentSession\(\)/);
  assert.match(route, /session\.role !== 'admin'/);
  assert.match(route, /persistFilesAgentDailySummary/);
  assert.doesNotMatch(route, /Promise\.all(?:Settled)?\s*\(/);
  assert.match(route, /limit\s+\$\d/i);
  assert.match(route, /where\s+id\s*>\s*\$\d/i);
  assert.match(route, /readFilesAgentDailySummary\(session\.company_id/);
  assert.doesNotMatch(route, /buildFilesAgentDailySummary\(session\.company_id/);
  assert.match(route, /cache-control.*no-store/is);
  assert.doesNotMatch(route, /resend|sendgrid|nodemailer|sendMail|fetch\(/i);
});

test('setup telemetry wipe includes durable summary rows without modifying shared db helpers', () => {
  const route = read('app/api/bootstrap/route.ts');
  assert.match(route, /wipeFilesAgentDailySummariesForSetup/);
  assert.match(route, /body\.action === 'wipe_telemetry'/);
  assert.match(route, /body\.action === 'wipe_telemetry_batch'/);
  assert.match(route, /withFilesAgentSummaryWipeLock/);
  assert.match(route, /setTelemetryPauseForSetup\(true\)/);
  assert.match(route, /while\s*\(/);
});
