import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const file = (path) => new URL(path, root);
const source = (path) => readFileSync(file(path), 'utf8');

function loadTs(path, stubs = {}, globals = {}) {
  assert.ok(existsSync(file(path)), `${path} must exist`);
  const javascript = ts.transpileModule(source(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, Buffer, URL, AbortController, DOMException, TextDecoder, setTimeout, clearTimeout, process, fetch, ...globals, require(specifier) {
    if (specifier === 'server-only') return {};
    if (specifier in stubs) return stubs[specifier];
    if (specifier === 'node:crypto' || specifier === 'crypto') return requireNodeCrypto;
    if (specifier === './git-remote') return loadTs('lib/git-remote.ts');
    if (specifier === './tracemini-progress') return { proposeProgress: () => null, traceMiniEvidenceKey: () => '0'.repeat(64) };
    throw new Error(`Unexpected import: ${specifier}`);
  } };
  vm.runInNewContext(javascript, sandbox, { filename: path });
  return module.exports;
}
const requireNodeCrypto = await import('node:crypto');

const migration = 'migrations/017_tracemini_integrations.sql';
const dbPath = 'lib/db.ts';
const service = 'lib/tracemini.ts';
const adapterPath = 'lib/tracemini-adapter.ts';
const cryptoPath = 'lib/tracemini-crypto.ts';
const normalizePath = 'lib/tracemini-normalize.ts';
const route = 'app/api/projects/[projectId]/tracemini/route.ts';
const dataRoute = 'app/api/projects/[projectId]/tracemini/data/route.ts';

const owner = { id: '1', role: 'employee', account_type: 'client' };
const engineer = { id: '2', role: 'employee', account_type: 'engineer' };
const admin = { id: '3', role: 'admin', account_type: 'admin' };

function normalizeLinked(mod, input, members = []) {
  const activity = (input.activity || []).map((event) => ({ repository_id: 'linked-repository', ...event }));
  return mod.normalizeTraceMiniData({
    dashboard: { events: activity, repositories: [{ id: 'linked-repository', name: 'app', normalized_remote: 'https://github.com/acme/widget.git' }], stats: {}, timeline: [] },
    settings: input.settings || {}, agents: input.agents || [], reports: input.reports || [],
  }, members, 'github.com/acme/widget');
}

test('management authorization permits owner clients and strict admins but rejects employees/engineers', () => {
  const mod = loadTs(service, { './db': {}, './projects': {}, './tracemini-adapter': {}, './tracemini-crypto': {}, './tracemini-normalize': {} });
  assert.equal(mod.isTraceMiniManager(owner, '1'), true);
  assert.equal(mod.isTraceMiniManager(admin, '999'), true);
  assert.equal(mod.isTraceMiniManager(engineer, '2'), false);
  assert.equal(mod.isTraceMiniManager({ ...owner, id: '9' }, '1'), false);
  const text = source(route);
  assert.match(text, /assertSameOrigin/);
  assert.match(text, /PUT|POST/);
});

test('project member read uses approved owner-or-active-member authorization', () => {
  const text = source(service);
  assert.match(text, /projectAccessSql/);
  assert.match(text, /membership_status='active'/);
  assert.match(source(dataRoute), /requireApiSession/);
});

test('TraceMini data GET is read-safe and proposal creation is an explicit same-origin POST', async () => {
  const routeSource = source(dataRoute);
  const serviceSource = source(service);
  const getHandler = routeSource.match(/export async function GET[\s\S]*?(?=export async function POST|$)/)?.[0] ?? '';
  const getService = serviceSource.match(/export async function getTraceMiniData[\s\S]*?\n}\n\n\/\*\*/)?.[0] ?? '';
  assert.doesNotMatch(getHandler, /proposeTraceMiniProgress/);
  assert.doesNotMatch(getService, /proposeTraceMiniProgress\s*\(/, 'a safe browser GET must never create proposals or evidence indirectly');
  assert.match(routeSource, /export async function POST/);
  assert.match(routeSource, /assertSameOrigin\s*\(request\)/);
  assert.match(routeSource, /proposeTraceMiniProgressForProject/);

  const session = { id: '1', role: 'employee', account_type: 'client' };
  let reads = 0;
  let proposals = 0;
  const route = loadTs(dataRoute, {
    'next/server': { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200, headers: init.headers }) } },
    '@/lib/api': {
      assertSameOrigin(request) { if (request.headers.get('origin') !== 'https://cloud.example') { const error = new Error('Invalid origin'); error.status = 403; throw error; } },
      async requireApiSession() { return session; },
      apiErrorResponse(error) { return { body: { ok: false, error: error.message }, status: error.status ?? 500 }; },
    },
    '@/lib/tracemini': {
      async getTraceMiniData(received, project) { reads += 1; assert.equal(received, session); assert.equal(project, '9'); return { state: 'fresh', data: { matchStatus: 'matched' } }; },
      async proposeTraceMiniProgressForProject(received, project) { proposals += 1; assert.equal(received, session); assert.equal(project, '9'); return true; },
    },
  });
  const context = { params: Promise.resolve({ projectId: '9' }) };
  const request = (origin) => ({ headers: { get: (name) => name === 'origin' ? origin : null } });
  const getResult = await route.GET(request(null), context);
  assert.equal(getResult.status, 200, 'ordinary reads remain usable without an Origin header');
  assert.equal(reads, 1);
  assert.equal(proposals, 0, 'GET must not create an action or evidence');
  for (const origin of [null, 'https://evil.example']) {
    const result = await route.POST(request(origin), context);
    assert.equal(result.status, 403, `${origin ?? 'missing origin'} POST must be rejected`);
  }
  const postResult = await route.POST(request('https://cloud.example'), context);
  assert.deepEqual({ ...postResult.body }, { ok: true, created: true });
  assert.equal(proposals, 1);
  assert.deepEqual(Object.keys(postResult.body).sort(), ['created', 'ok'], 'POST must not expose evidence or upstream payloads');
});

test('unrelated users are denied and strict platform admin checks both role and account type', () => {
  const text = source(service);
  assert.match(text, /Project not found/);
  assert.match(text, /session\.role === 'admin'[\s\S]*session\.account_type === 'admin'/);
  assert.doesNotMatch(text, /role === 'admin'\s*\)\s*return true/);
});

test('migration is one-per-project, cascades, and stores an AES-GCM envelope without plaintext', () => {
  const sql = source(migration);
  assert.match(sql, /project_id bigint primary key[\s\S]*references projects\(id\) on delete cascade/i);
  assert.match(sql, /credential_ciphertext bytea/i);
  assert.match(sql, /credential_iv bytea/i);
  assert.match(sql, /credential_tag bytea/i);
  assert.match(sql, /config_revision bigint not null default 1/i);
  assert.match(sql, /create sequence if not exists tracemini_integration_generation_seq/i);
  assert.match(sql, /config_generation bigint not null default nextval\('tracemini_integration_generation_seq'/i);
  assert.match(sql, /add column if not exists config_generation bigint[\s\S]*nextval\('tracemini_integration_generation_seq'/i);
  assert.match(sql, /alter column config_generation set default nextval\('tracemini_integration_generation_seq'/i);
  assert.match(sql, /alter column config_generation set not null/i);
  const runtimeSchema = source(dbPath);
  assert.match(runtimeSchema, /create sequence if not exists tracemini_integration_generation_seq/i);
  assert.match(runtimeSchema, /config_generation bigint not null default nextval\('tracemini_integration_generation_seq'/i);
  assert.match(runtimeSchema, /add column if not exists config_generation bigint[\s\S]*nextval\('tracemini_integration_generation_seq'/i);
  assert.doesNotMatch(sql, /token\s+text|credential\s+text/i);
  const cryptoSource = source(cryptoPath);
  assert.match(cryptoSource, /aes-256-gcm/);
  assert.match(cryptoSource, /TRACEMINI_ENCRYPTION_KEY/);
  assert.match(cryptoSource, /randomBytes\(12\)/);
  assert.match(cryptoSource, /setAAD/);
  assert.doesNotMatch(cryptoSource, /AUTH_SECRET|INGEST_API_KEY|ADMIN_SETUP_KEY/);
});

test('AES-256-GCM round trips with project-bound AAD and fails closed for wrong key/project', () => {
  const mod = loadTs(cryptoPath);
  const old = process.env.TRACEMINI_ENCRYPTION_KEY;
  process.env.TRACEMINI_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  try {
    const envelope = mod.encryptTraceMiniCredential('42', 'secret-session-token');
    assert.equal(Buffer.from(envelope.iv).length, 12);
    assert.equal(Buffer.from(envelope.tag).length, 16);
    assert.equal(mod.decryptTraceMiniCredential('42', envelope), 'secret-session-token');
    assert.throws(() => mod.decryptTraceMiniCredential('43', envelope));
    process.env.TRACEMINI_ENCRYPTION_KEY = Buffer.alloc(31).toString('base64');
    assert.throws(() => mod.encryptTraceMiniCredential('42', 'x'), /32/);
  } finally { if (old === undefined) delete process.env.TRACEMINI_ENCRYPTION_KEY; else process.env.TRACEMINI_ENCRYPTION_KEY = old; }
});

test('base URL validation permits HTTP loopback only in explicit development', () => {
  const mod = loadTs(adapterPath);
  const oldAllowed = process.env.TRACEMINI_ALLOWED_ORIGINS;
  const oldNode = process.env.NODE_ENV;
  process.env.TRACEMINI_ALLOWED_ORIGINS = 'https://trace.example.com,http://127.0.0.1:7777';
  try {
    assert.equal(mod.validateTraceMiniBaseUrl('https://trace.example.com/'), 'https://trace.example.com');
    for (const value of ['http://trace.example.com', 'https://evil.example.com', 'https://u:***@trace.example.com', 'https://trace.example.com/api', 'https://trace.example.com?q=1', 'https://trace.example.com/#x', 'file:///tmp/x']) assert.throws(() => mod.validateTraceMiniBaseUrl(value));
    for (const environment of [undefined, 'test', 'staging', 'production']) {
      if (environment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = environment;
      assert.throws(() => mod.validateTraceMiniBaseUrl('http://127.0.0.1:7777'), environment || 'unset');
    }
    process.env.NODE_ENV = 'development';
    assert.equal(mod.validateTraceMiniBaseUrl('http://127.0.0.1:7777'), 'http://127.0.0.1:7777');
  } finally { if (oldAllowed === undefined) delete process.env.TRACEMINI_ALLOWED_ORIGINS; else process.env.TRACEMINI_ALLOWED_ORIGINS = oldAllowed; if (oldNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNode; }
});

test('adapter exports a GET-only API, builds paths internally, bounds bodies and retries only transient failures', () => {
  const mod = loadTs(adapterPath);
  assert.equal(typeof mod.traceMiniGet, 'function');
  assert.equal(mod.traceMiniPost, undefined);
  assert.equal(mod.traceMiniPut, undefined);
  assert.equal(mod.traceMiniDelete, undefined);
  const text = source(adapterPath);
  assert.match(text, /method:\s*'GET'/);
  assert.match(text, /Content-Length|content-length/);
  assert.match(text, /getReader\(\)/);
  assert.match(text, /502|503|504/);
  assert.match(text, /attempt\s*<\s*2|attempt\s*===\s*0/);
});

test('adapter sends GET and retries exactly once only for transient status, network, and timeout failures', async () => {
  const oldAllowed = process.env.TRACEMINI_ALLOWED_ORIGINS;
  process.env.TRACEMINI_ALLOWED_ORIGINS = 'https://trace.example.com';
  try {
    for (const failure of [502, 503, 504, 'network', 'timeout']) {
      const calls = [];
      const fetchMock = async (url, options) => {
        calls.push({ url, options });
        if (calls.length === 1) {
          if (failure === 'network') throw new TypeError('socket secret');
          if (failure === 'timeout') { const error = new Error('internal path'); error.name = 'AbortError'; throw error; }
          return new Response('{}', { status: failure });
        }
        return new Response('{}', { status: 200 });
      };
      const mod = loadTs(adapterPath, {}, { fetch: fetchMock });
      await mod.traceMiniGet('https://trace.example.com', 'credential', 'bootstrap', undefined, { timeoutMs: 20 });
      assert.equal(calls.length, 2, String(failure));
      assert.ok(calls.every((call) => call.options.method === 'GET'));
    }
    for (const response of [
      () => new Response('{}', { status: 401 }),
      () => new Response('{bad', { status: 200 }),
      () => new Response('{}', { status: 200, headers: { 'content-length': '1048577' } }),
    ]) {
      let calls = 0;
      const mod = loadTs(adapterPath, {}, { fetch: async () => { calls += 1; return response(); } });
      await assert.rejects(mod.traceMiniGet('https://trace.example.com', 'credential', 'bootstrap'));
      assert.equal(calls, 1);
    }
  } finally { if (oldAllowed === undefined) delete process.env.TRACEMINI_ALLOWED_ORIGINS; else process.env.TRACEMINI_ALLOWED_ORIGINS = oldAllowed; }
});

test('adapter cancels a stream after it exceeds the byte limit and reports malformed bodies safely', async () => {
  const oldAllowed = process.env.TRACEMINI_ALLOWED_ORIGINS;
  process.env.TRACEMINI_ALLOWED_ORIGINS = 'https://trace.example.com';
  try {
    let cancelled = false;
    const oversized = { ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({
      read: async () => ({ done: false, value: new Uint8Array(1_048_577) }),
      cancel: async () => { cancelled = true; },
    }) } };
    let mod = loadTs(adapterPath, {}, { fetch: async () => oversized });
    await assert.rejects(mod.traceMiniGet('https://trace.example.com', 'secret', 'bootstrap'), /too large/i);
    assert.equal(cancelled, true);
    mod = loadTs(adapterPath, {}, { fetch: async () => new Response('password=hunter2 at /srv/db.sql', { status: 200 }) });
    await assert.rejects(mod.traceMiniGet('https://trace.example.com', 'secret', 'bootstrap'), (error) => error.message === 'Invalid TraceMini response: malformed JSON');
  } finally { if (oldAllowed === undefined) delete process.env.TRACEMINI_ALLOWED_ORIGINS; else process.env.TRACEMINI_ALLOWED_ORIGINS = oldAllowed; }
});

test('timeout/outage refresh returns stale last-good data and page-safe unavailable state', () => {
  const text = source(service);
  assert.match(text, /AbortController|traceMiniGet/);
  assert.match(text, /stale/);
  assert.match(text, /unavailable/);
  assert.match(text, /last_successful_sync/);
  assert.match(text, /last_error/);
  assert.match(text, /30_000/);
});

test('malformed upstream payloads are rejected without exposing body or credential', () => {
  const adapter = source(adapterPath);
  assert.match(adapter, /Invalid TraceMini response|malformed/i);
  assert.doesNotMatch(adapter, /console\.(?:log|error)[\s\S]*(?:body|token|credential|cipher)/i);
  const routes = source(route) + source(dataRoute);
  assert.doesNotMatch(routes, /credential_ciphertext|credential_iv|credential_tag|token\s*:/);
});

test('connection test and live refresh share strict dashboard envelope validation', () => {
  const text = source(service);
  assert.match(text, /validateTraceMiniDashboardEnvelope/);
  assert.ok((text.match(/validateTraceMiniDashboardEnvelope\(/g) || []).length >= 3, 'definition plus test and refresh usage');
  for (const field of ['events', 'repositories', 'timeline']) assert.match(text, new RegExp(`Array\\.isArray\\(dashboard\\.${field}\\)`));
  assert.match(text, /dashboard\.stats[\s\S]*typeof[\s\S]*object/);
});

test('identity mapping uses trimmed lowercase exact email only', () => {
  const mod = loadTs(normalizePath);
  const members = [{ id: '9', email: ' Alice@Example.COM ', display_name: 'Alice Smith' }];
  assert.equal(mod.mapTraceMiniIdentity(' alice@example.com ', members).label, 'Alice Smith');
  assert.equal(mod.mapTraceMiniIdentity('Alice Smith', members).mapped, false);
  assert.equal(mod.mapTraceMiniIdentity('alice', members).mapped, false);
});

test('unknown upstream identities receive the explicit unmapped label', () => {
  const mod = loadTs(normalizePath);
  const result = normalizeLinked(mod, { activity: [{ id: '1', type: 'commit', user_name: 'other@example.com', occurred_at: '2026-01-01T00:00:00Z', data: {} }], repositories: [], agents: [], reports: [] }, [{ id: '9', email: 'alice@example.com', display_name: 'Alice' }]);
  assert.equal(result.recentActivity[0].member.label, 'Unmapped TraceMini member');
  assert.equal(result.memberActivity[0].member.label, 'Unmapped TraceMini member');
});

test('normalization preserves true Git type and only contracted confirmation state', () => {
  const mod = loadTs(normalizePath);
  const confirmation = { confirmed: true, status: 'pending', method: 'password=hunter2' };
  const result = normalizeLinked(mod, { activity: [{ id: '1', type: 'git.push.rejected', user_name: 'alice@example.com', occurred_at: '2026-01-01T00:00:00Z', data: { confirmation, message: 'safe' } }], repositories: [], agents: [], reports: [] }, [{ id: '9', email: 'alice@example.com', display_name: 'Alice' }]);
  assert.equal(result.recentActivity[0].type, 'git.push.rejected');
  assert.deepEqual(JSON.parse(JSON.stringify(result.recentActivity[0].data.confirmation)), { confirmed: true, status: 'pending' });
});

test('browser DTO is fail-closed for credential-shaped and source-code strings', () => {
  const mod = loadTs(normalizePath);
  const secrets = [
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
    '-----BEGIN PRIVATE KEY-----',
    'password=hunter2 api_key=sk-live-verysecret',
    'function steal() { return process.env.SECRET; }',
  ];
  const output = normalizeLinked(mod, {
    activity: secrets.map((secret, index) => ({ type: index ? 'git.commit' : 'git.push.rejected', occurred_at: `2026-01-01T00:00:0${index}Z`, repository_name: secret, data: { message: secret, branch: secret, headSha: secret, remoteHeadSha: secret, confirmation: { confirmed: false, status: 'unconfirmed', note: secret } } })),
    repositories: secrets.map((name) => ({ name })), agents: [],
    reports: secrets.map((title) => ({ title, name: title, status: title, created_at: '2026-01-01T00:00:00Z' })),
  }, []);
  const serialized = JSON.stringify(output);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(output.recentActivity[0].type, 'git.push.rejected');
  assert.deepEqual(JSON.parse(JSON.stringify(output.recentActivity[0].data.confirmation)), { confirmed: false, status: 'unconfirmed' });
});

test('confirmation renderer exposes known state without stringifying arbitrary objects', () => {
  const mod = loadTs('lib/tracemini-confirmation.ts');
  assert.equal(mod.renderTraceMiniConfirmation(true), 'Confirmed');
  assert.equal(mod.renderTraceMiniConfirmation(false), 'Unconfirmed');
  assert.equal(mod.renderTraceMiniConfirmation({ confirmed: true, note: 'password=hunter2' }), 'Confirmed');
  assert.equal(mod.renderTraceMiniConfirmation({ status: 'pending', note: 'secret' }), 'Pending');
  assert.equal(mod.renderTraceMiniConfirmation({ note: 'secret' }), null);
  const ui = source('app/projects/[projectId]/WorkspaceClient.tsx');
  assert.match(ui, /renderTraceMiniConfirmation\(event\.data\.confirmation\)/);
});

test('frontend/API DTOs omit credentials, local paths, remote URLs and device identifiers while showing safe TraceMini UI', () => {
  const mod = loadTs(normalizePath);
  const output = normalizeLinked(mod, {
    activity: [{ id: 'evt-secret', local_key: '/home/alice/key', type: 'commit', user_name: 'alice@example.com', occurred_at: '2026-01-01T00:00:00Z', data: { path: '/home/alice/repo', files: ['/secret/a'], remoteUrl: 'ssh://secret', token: 'secret', message: 'ok' } }],
    repositories: [{ id: 'repo-secret', name: 'app', remote_url: 'ssh://private', archived: false, clone_count: 2 }],
    agents: [{ id: 'agent-secret', repository_id: 'linked-repository', user_name: 'alice@example.com', machine_name: 'alice-laptop', status: 'online', last_seen: '2026-01-01T00:00:00Z' }],
    reports: [{ id: 'report-1', repository_id: 'linked-repository', title: 'Weekly', markdown: '# private', created_at: '2026-01-01T00:00:00Z' }],
  }, [{ id: '9', email: 'alice@example.com', display_name: 'Alice' }]);
  const serialized = JSON.stringify(output);
  for (const secret of ['/home/alice', 'ssh://', 'repo-secret', 'agent-secret', '# private']) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(output.devices[0].member.label, 'Alice');
  const ui = source('app/projects/[projectId]/WorkspaceClient.tsx');
  for (const label of ['Data from TraceMini', 'Recent Git activity', 'Repository summaries', 'Connected-device status', 'Member activity', 'Report metadata']) assert.match(ui, new RegExp(label));
  assert.match(ui, /stale|unavailable/);
});

test('normalization rejects arbitrary absolute paths, remote URL forms, and embedded auth secrets', () => {
  const mod = loadTs(normalizePath);
  const output = normalizeLinked(mod, {
    activity: [
      { type: 'commit', occurred_at: '2026-01-01T00:00:00Z', repository_name: '/etc/private-repository', data: { message: 'read /opt/build/private.log' } },
      { type: 'commit', occurred_at: '2026-01-01T00:00:01Z', data: { message: 'mirror git@github.com:private/repo.git' } },
      { type: 'commit', occurred_at: '2026-01-01T00:00:02Z', data: { message: 'Cookie: session=super-secret-cookie' } },
      { type: 'commit', occurred_at: '2026-01-01T00:00:03Z', data: { message: 'Authorization: Bearer super-secret-token' } },
      { type: 'commit', occurred_at: '2026-01-01T00:00:04Z', data: { message: 'fetch ftp://private.example/repo' } },
    ],
    repositories: [], agents: [], reports: [],
  }, []);
  const serialized = JSON.stringify(output);
  for (const secret of ['/etc/private-repository', '/opt/build/private.log', 'git@github.com:private/repo.git', 'super-secret-cookie', 'super-secret-token', 'ftp://private.example']) assert.equal(serialized.includes(secret), false, secret);
});

test('TraceMini settings visibility is derived server-side for the owning client or a strict platform admin', () => {
  const page = source('app/projects/[projectId]/page.tsx');
  const ui = source('app/projects/[projectId]/WorkspaceClient.tsx');
  assert.match(page, /session\.account_type\s*===\s*'admin'\s*&&\s*session\.role\s*===\s*'admin'/);
  assert.match(page, /session\.account_type\s*===\s*'client'\s*&&\s*String\(project\.client_id\)\s*===\s*String\(session\.id\)/);
  assert.match(page, /canManageTraceMini=\{canManageTraceMini\}/);
  assert.match(ui, /canManageTraceMini:\s*boolean/);
  assert.doesNotMatch(ui, /const canManageTraceMini\s*=\s*accountType/);
});

test('an authorized project without an integration returns an unconfigured page state', async () => {
  let accessQuery = '';
  const db = { async query(sql) { accessQuery = sql; return { rows: [{ authorized_project_id: '42', project_id: null }] }; } };
  class ProjectServiceError extends Error { constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; } }
  const mod = loadTs(service, {
    './db': { ensureSchema: async () => {}, getPool: () => db },
    './projects': { ProjectServiceError, projectAccessSql: () => ({ join: '', predicate: 'true' }) },
    './tracemini-adapter': {}, './tracemini-crypto': {}, './tracemini-normalize': {},
  });
  const result = await mod.getTraceMiniData({ id: '1', role: 'employee', account_type: 'engineer' }, '42');
  assert.match(accessQuery, /left join project_tracemini_integrations/i);
  assert.equal(result.state, 'unconfigured');
  assert.equal(result.data, null);
});

test('invalid saved base URLs produce a client-safe 400 instead of an internal error', async () => {
  const db = { async query() { return { rows: [{ id: '42', client_id: '1' }] }; } };
  class ProjectServiceError extends Error { constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; } }
  const mod = loadTs(service, {
    './db': { ensureSchema: async () => {}, getPool: () => db },
    './projects': { ProjectServiceError, projectAccessSql: () => ({ join: '', predicate: 'true' }) },
    './tracemini-adapter': { validateTraceMiniBaseUrl() { throw new Error('TraceMini origin is not trusted'); } },
    './tracemini-crypto': {}, './tracemini-normalize': {},
  });
  await assert.rejects(
    mod.saveTraceMiniConfig({ id: '1', role: 'employee', account_type: 'client' }, '42', { baseUrl: 'https://evil.example', workspaceId: 'workspace', credential: 'secret' }),
    (error) => error instanceof ProjectServiceError && error.status === 400 && error.message === 'TraceMini origin is not trusted',
  );
});

test('service rejects an unrelated reader and never mutates project memberships', async () => {
  const queries = [];
  const db = { async query(sql, params) { queries.push({ sql, params }); return { rows: [] }; } };
  class ProjectServiceError extends Error { constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; } }
  const mod = loadTs(service, {
    './db': { ensureSchema: async () => {}, getPool: () => db },
    './projects': { ProjectServiceError, projectAccessSql: () => ({ join: 'join project_memberships pm on false', predicate: 'false' }) },
    './tracemini-adapter': {}, './tracemini-crypto': {}, './tracemini-normalize': {},
  });
  await assert.rejects(mod.getTraceMiniData({ id: '999', role: 'employee', account_type: 'engineer' }, '42'), (error) => error.status === 404);
  assert.equal(queries.some(({ sql }) => /(?:insert|update)\s+(?:into\s+)?project_memberships/i.test(sql)), false);
});

test('saving an existing config without a credential preserves its ciphertext', async () => {
  const queries = [];
  const db = { async query(sql, params) {
    queries.push({ sql, params });
    if (/select id,client_id from projects/i.test(sql)) return { rows: [{ id: '42', client_id: '1' }] };
    if (/select credential_version/i.test(sql)) return { rows: [{ credential_version: 1 }] };
    if (/from project_tracemini_integrations join projects/i.test(sql)) return { rows: [{ project_id: '42', enabled: true, base_url: 'https://trace.example.com', workspace_id: 'ws', last_successful_sync: null, last_error: null, updated_at: new Date() }] };
    return { rows: [] };
  } };
  class ProjectServiceError extends Error { constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; } }
  const mod = loadTs(service, {
    './db': { ensureSchema: async () => {}, getPool: () => db },
    './projects': { ProjectServiceError, projectAccessSql: () => ({ join: '', predicate: 'true' }) },
    './tracemini-adapter': { validateTraceMiniBaseUrl: () => 'https://trace.example.com' },
    './tracemini-crypto': { encryptTraceMiniCredential: () => { throw new Error('must not encrypt'); } },
    './tracemini-normalize': {},
  });
  await mod.saveTraceMiniConfig(owner, '42', { baseUrl: 'https://trace.example.com', workspaceId: 'ws' });
  const write = queries.find(({ sql }) => /^update project_tracemini_integrations set/i.test(sql.trim()));
  assert.ok(write);
  assert.doesNotMatch(write.sql, /credential_(?:ciphertext|iv|tag)/i);
  assert.equal(queries.some(({ sql }) => /(?:insert|update)\s+(?:into\s+)?project_memberships/i.test(sql)), false);
});

test('service persists and renders only allowlisted upstream errors, never DB or crypto internals', async () => {
  for (const [secret, sourceKind] of [['error:03000086 digital envelope routines at /srv/key.pem', 'crypto'], ['SELECT * FROM secrets password=hunter2', 'database']]) {
    const persisted = [];
    const row = { project_id: '42', client_id: '1', enabled: true, base_url: 'https://trace.example.com', workspace_id: 'ws', updated_at: '2026-01-01T00:00:00.000Z', credential_version: 1, credential_ciphertext: Buffer.from('x'), credential_iv: Buffer.from('x'), credential_tag: Buffer.from('x'), last_successful_sync: null };
    const db = { async query(sql, params) {
      if (/left join project_tracemini_integrations/i.test(sql)) return { rows: [row] };
      if (/set last_error/i.test(sql)) { persisted.push(params[1]); return { rows: [] }; }
      if (/set last_successful_sync/i.test(sql)) return { rows: [{ project_id: '42' }] };
      if (sourceKind === 'database' && /select u.id,u.email/i.test(sql)) throw new Error(secret);
      return { rows: [] };
    } };
    class ProjectServiceError extends Error { constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; } }
    const mod = loadTs(service, {
      './db': { ensureSchema: async () => {}, getPool: () => db },
      './projects': { ProjectServiceError, projectAccessSql: () => ({ join: '', predicate: 'true' }) },
      './tracemini-adapter': { traceMiniGet: async (_url, _credential, endpoint, workspace) => validUpstream(endpoint, workspace) },
      './tracemini-crypto': { decryptTraceMiniCredential: () => { if (sourceKind === 'crypto') throw new Error(secret); return 'credential'; } },
      './tracemini-normalize': { normalizeTraceMiniData: () => ({}) },
    });
    const result = await mod.getTraceMiniData(engineer, '42');
    assert.equal(result.lastError, 'TraceMini is unavailable');
    assert.deepEqual(persisted, ['TraceMini is unavailable']);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('stored legacy errors are fail-closed before being returned to the browser', async () => {
  const secret = 'SQLSTATE 42P01 /var/lib/postgresql password=hunter2';
  const db = { async query(sql) {
    if (/select id,client_id from projects/i.test(sql)) return { rows: [{ id: '42', client_id: '1' }] };
    return { rows: [{ project_id: '42', enabled: true, base_url: 'https://trace.example.com', workspace_id: 'ws', config_generation: '987', config_revision: '654', last_successful_sync: null, last_error: secret, updated_at: new Date() }] };
  } };
  class ProjectServiceError extends Error { constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; } }
  const mod = loadTs(service, {
    './db': { ensureSchema: async () => {}, getPool: () => db },
    './projects': { ProjectServiceError, projectAccessSql: () => ({ join: '', predicate: 'true' }) },
    './tracemini-adapter': {}, './tracemini-crypto': {}, './tracemini-normalize': {},
  });
  const config = await mod.getTraceMiniConfig(owner, '42');
  assert.equal(config.lastError, 'TraceMini is unavailable');
  assert.equal(JSON.stringify(config).includes(secret), false);
  assert.equal(Object.hasOwn(config, 'config_generation'), false);
  assert.equal(Object.hasOwn(config, 'config_revision'), false);
  assert.equal(Object.hasOwn(config, 'configGeneration'), false);
  assert.equal(Object.hasOwn(config, 'configRevision'), false);
});

test('a failed refresh returns stale last-good data with a safe error', async () => {
  let now = 1_700_000_000_000;
  class FakeDate extends Date { constructor(value) { super(value === undefined ? now : value); } static now() { return now; } }
  let fail = false;
  const row = { project_id: '77', client_id: '1', enabled: true, base_url: 'https://trace.example.com', workspace_id: 'ws', git_repository_key: 'github.com/acme/widget', config_generation: '1', config_revision: '1', updated_at: '2026-01-01T00:00:00.000Z', credential_version: 1, credential_ciphertext: Buffer.from('x'), credential_iv: Buffer.from('x'), credential_tag: Buffer.from('x'), last_successful_sync: null };
  const db = { async query(sql) {
    if (/left join project_tracemini_integrations/i.test(sql)) return { rows: [row] };
    if (/select u.id,u.email/i.test(sql)) return { rows: [] };
    if (/select git_repository_key from projects/i.test(sql)) return { rows: [{ git_repository_key: row.git_repository_key }] };
    if (/insert into project_tracemini_repository_matches/i.test(sql)) return { rows: [{ project_id: row.project_id }] };
    if (/update project_tracemini_integrations/i.test(sql)) return { rows: [{ project_id: '77' }] };
    return { rows: [] };
  } };
  class ProjectServiceError extends Error { constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; } }
  const mod = loadTs(service, {
    './db': { ensureSchema: async () => {}, getPool: () => db },
    './projects': { ProjectServiceError, projectAccessSql: () => ({ join: '', predicate: 'true' }) },
    './tracemini-adapter': { traceMiniGet: async (_url, _credential, endpoint, workspace) => { if (fail) throw Object.assign(new Error('socket /secret'), { code: 'temporary_outage' }); return validUpstream(endpoint, workspace); } },
    './tracemini-crypto': { decryptTraceMiniCredential: () => 'credential' },
    './tracemini-normalize': { normalizeTraceMiniData: () => ({ marker: 'last-good' }) },
  }, { Date: FakeDate });
  const fresh = await mod.getTraceMiniData(engineer, '77');
  assert.equal(fresh.state, 'fresh');
  fail = true;
  now += 31_000;
  const stale = await mod.getTraceMiniData(engineer, '77');
  assert.equal(stale.state, 'stale');
  assert.equal(stale.data.marker, 'last-good');
  assert.equal(stale.lastError, 'TraceMini is temporarily unavailable');
});

function validUpstream(endpoint, workspace = 'ws') {
  if (endpoint === 'bootstrap') return { workspaces: [{ id: workspace }] };
  if (endpoint === 'dashboard') return { events: [], repositories: [], stats: {}, timeline: [] };
  if (endpoint === 'settings') return {};
  return [];
}

function loadTraceMiniService({ db, traceMiniGet = async (_url, _credential, endpoint, workspace) => validUpstream(endpoint, workspace), normalizeTraceMiniData = (input, members) => ({ input, members }), DateClass } = {}) {
  class ProjectServiceError extends Error { constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; } }
  return loadTs(service, {
    './db': { ensureSchema: async () => {}, getPool: () => db },
    './projects': { ProjectServiceError, projectAccessSql: () => ({ join: '', predicate: 'true' }) },
    './tracemini-adapter': { traceMiniGet },
    './tracemini-crypto': { decryptTraceMiniCredential: () => 'credential' },
    './tracemini-normalize': { normalizeTraceMiniData },
  }, DateClass ? { Date: DateClass } : {});
}

const integrationRow = (project = '88', overrides = {}) => ({ project_id: project, authorized_project_id: project, client_id: '1', enabled: true, base_url: 'https://trace.example.com', workspace_id: 'ws', git_repository_key: 'github.com/acme/widget', config_generation: '1', config_revision: '1', updated_at: '2026-01-01T00:00:00.000Z', credential_version: 1, credential_ciphertext: Buffer.from('x'), credential_iv: Buffer.from('x'), credential_tag: Buffer.from('x'), last_successful_sync: null, ...overrides });

function traceDb(currentRow, members = () => []) {
  const writes = [];
  return { writes, async query(sql, params = []) {
    const row = currentRow();
    if (/left join project_tracemini_integrations/i.test(sql) || /select (?:project_id|base_url).*from project_tracemini_integrations/i.test(sql)) return { rows: row ? [row] : [] };
    if (/select u.id,u.email/i.test(sql)) return { rows: members() };
    if (/select git_repository_key from projects/i.test(sql)) return { rows: [{ git_repository_key: 'github.com/acme/widget' }] };
    if (/insert into project_tracemini_repository_matches/i.test(sql)) return { rows: [{ project_id: row?.project_id }] };
    if (/update project_tracemini_integrations/i.test(sql)) { writes.push(params); return { rows: [row] }; }
    return { rows: [] };
  } };
}

test('strict platform admin read binds exactly the SQL placeholders it uses', async () => {
  const row = integrationRow('42', { enabled: false });
  const db = { async query(sql, params = []) {
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    assert.equal(params.length, placeholders.length ? Math.max(...placeholders) : 0, sql);
    return { rows: [row] };
  } };
  const result = await loadTraceMiniService({ db }).getTraceMiniData(admin, '42');
  assert.equal(result.state, 'disabled');
});

test('adapter cancels non-2xx bodies before retrying or throwing', async () => {
  const oldAllowed = process.env.TRACEMINI_ALLOWED_ORIGINS;
  process.env.TRACEMINI_ALLOWED_ORIGINS = 'https://trace.example.com';
  try {
    for (const status of [503, 401]) {
      let calls = 0;
      let cancellations = 0;
      const mod = loadTs(adapterPath, {}, { fetch: async () => {
        calls += 1;
        const code = status === 503 && calls === 2 ? 200 : status;
        if (code === 200) return new Response('{}');
        return { ok: false, status: code, headers: new Headers(), body: { cancel: async () => { cancellations += 1; } } };
      } });
      if (status === 503) await mod.traceMiniGet('https://trace.example.com', 'credential', 'bootstrap');
      else await assert.rejects(mod.traceMiniGet('https://trace.example.com', 'credential', 'bootstrap'));
      assert.equal(cancellations, 1, `status ${status}`);
      assert.equal(calls, status === 503 ? 2 : 1);
    }
  } finally { if (oldAllowed === undefined) delete process.env.TRACEMINI_ALLOWED_ORIGINS; else process.env.TRACEMINI_ALLOWED_ORIGINS = oldAllowed; }
});

test('numeric config revision supersedes an old in-flight read even when timestamps are identical', async () => {
  let row = integrationRow('88', { config_revision: '41' });
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const db = traceDb(() => row);
  const calls = [];
  const traceMiniGet = async (_url, _credential, endpoint) => {
    const revision = row.config_revision;
    calls.push({ endpoint, revision });
    if (revision === '41') await gateA;
    if (endpoint === 'dashboard') return { ...validUpstream(endpoint), stats: { revision } };
    return validUpstream(endpoint);
  };
  const mod = loadTraceMiniService({ db, traceMiniGet, normalizeTraceMiniData: (input) => ({ revision: input.dashboard.stats.revision }) });
  const requestA = mod.getTraceMiniData(engineer, '88');
  await new Promise((resolve) => setImmediate(resolve));
  row = integrationRow('88', { config_revision: '42', updated_at: '2026-01-01T00:00:00.000Z' });
  releaseA();
  const resultA = await requestA;
  assert.equal(resultA.data, null);
  assert.equal(db.writes.length, 0, 'revision 41 must not update revision 42 sync/error fields');
  const resultB = await mod.getTraceMiniData(engineer, '88');
  assert.equal(resultB.data.revision, '42');
  assert.ok(calls.some((call) => call.revision === '42'), 'revision 42 must fetch instead of receiving revision 41 from cache');
});

test('an old in-flight connection test cannot update or verify a replacement config', async () => {
  let row = integrationRow('95', { config_revision: '7', workspace_id: 'workspace-a', last_error: 'replacement error' });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const writes = [];
  const db = { async query(sql, params = []) {
    if (/select id,client_id from projects/i.test(sql)) return { rows: [{ id: '95', client_id: '1' }] };
    if (/select i\.\*,p\.client_id/i.test(sql)) return { rows: [row] };
    if (/update project_tracemini_integrations/i.test(sql)) {
      writes.push({ sql, params });
      return { rows: String(params[params.length - 1]) === String(row.config_revision) ? [{ project_id: '95' }] : [] };
    }
    return { rows: [] };
  } };
  const mod = loadTraceMiniService({ db, traceMiniGet: async (_url, _credential, endpoint) => {
    if (endpoint === 'bootstrap') { await gate; return { workspaces: [{ id: 'workspace-a' }] }; }
    return {};
  } });
  const request = mod.testTraceMiniConnection(owner, '95');
  await new Promise((resolve) => setImmediate(resolve));
  row = integrationRow('95', { config_revision: '8', workspace_id: 'workspace-b', last_error: 'replacement error' });
  release();
  await assert.rejects(request, (error) => error.status === 409 && error.code === 'config_superseded');
  assert.equal(row.last_error, 'replacement error');
  assert.ok(writes.every(({ sql }) => /project_id=\$1[\s\S]*config_revision=\$\d+/i.test(sql)));
});

test('delete and recreate isolates revision-1 cache, fetches, and connection-test writes by generation', async () => {
  let row = integrationRow('98', { config_generation: '500', config_revision: '1', workspace_id: 'workspace-old', last_error: null });
  let releaseOld;
  const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  const calls = [];
  const writes = [];
  const db = { async query(sql, params = []) {
    if (/select id,client_id from projects/i.test(sql)) return { rows: [{ id: '98', client_id: '1' }] };
    if (/left join project_tracemini_integrations/i.test(sql) || /select i\.\*,p\.client_id/i.test(sql)) return { rows: [row] };
    if (/select u.id,u.email/i.test(sql)) return { rows: [] };
    if (/select git_repository_key from projects/i.test(sql)) return { rows: [{ git_repository_key: row.git_repository_key }] };
    if (/insert into project_tracemini_repository_matches/i.test(sql)) return { rows: [{ project_id: row.project_id }] };
    if (/update project_tracemini_integrations/i.test(sql)) {
      writes.push({ sql, params });
      const revision = String(params[params.length - 1]);
      const generationMatches = !/config_generation=\$\d+/i.test(sql) || String(params[params.length - 2]) === String(row.config_generation);
      const matches = generationMatches && revision === String(row.config_revision);
      if (matches && /set last_error=null/i.test(sql)) row.last_error = null;
      if (matches && /set last_error=\$2/i.test(sql)) row.last_error = params[1];
      return { rows: matches ? [{ project_id: '98' }] : [] };
    }
    return { rows: [] };
  } };
  const mod = loadTraceMiniService({ db, traceMiniGet: async (_url, _credential, endpoint, workspace) => {
    const generation = row.config_generation;
    const workspaceId = row.workspace_id;
    calls.push({ endpoint, generation });
    if (generation === '500') await oldGate;
    if (endpoint === 'bootstrap') return { workspaces: [{ id: workspaceId }] };
    if (endpoint === 'dashboard') return { ...validUpstream(endpoint), stats: { source: generation } };
    return validUpstream(endpoint, workspace);
  }, normalizeTraceMiniData: (input) => ({ source: input.dashboard.stats.source }) });

  const oldRead = mod.getTraceMiniData(engineer, '98');
  const oldTest = mod.testTraceMiniConnection(owner, '98');
  await new Promise((resolve) => setImmediate(resolve));
  row = integrationRow('98', { config_generation: '501', config_revision: '1', workspace_id: 'workspace-new', last_error: 'replacement error' });
  releaseOld();

  const oldResult = await oldRead;
  await assert.rejects(oldTest, (error) => error.status === 409 && error.code === 'config_superseded');
  assert.equal(oldResult.data, null, 'deleted generation must not be served after replacement');
  assert.equal(row.last_error, 'replacement error', 'deleted generation must not update replacement status');

  const replacement = await mod.getTraceMiniData(engineer, '98');
  assert.equal(replacement.data.source, '501', 'replacement must not share old in-flight data or cache');
  const replacementCallCount = calls.filter((call) => call.generation === '501').length;
  const cachedReplacement = await mod.getTraceMiniData(engineer, '98');
  assert.equal(cachedReplacement.data.source, '501');
  assert.equal(calls.filter((call) => call.generation === '501').length, replacementCallCount, 'replacement cache may only contain replacement data');
  assert.ok(writes.every(({ sql }) => /project_id=\$1[\s\S]*config_generation=\$\d+[\s\S]*config_revision=\$\d+/i.test(sql)));
});

test('configuration saves increment revision while sync status writes do not', async () => {
  const serviceText = source(service);
  assert.match(serviceText, /config_revision\s*=\s*project_tracemini_integrations\.config_revision\s*\+\s*case/i);
  assert.match(serviceText, /is distinct from/i);

  let saved = integrationRow('97', { workspace_id: 'old-workspace', config_revision: '12' });
  const saveWrites = [];
  const saveDb = { async query(sql, params = []) {
    if (/select id,client_id from projects/i.test(sql)) return { rows: [{ id: '97', client_id: '1' }] };
    if (/select credential_version/i.test(sql)) return { rows: [saved] };
    if (/^\s*update project_tracemini_integrations set/i.test(sql)) {
      saveWrites.push(sql);
      const changed = saved.base_url !== params[1] || saved.workspace_id !== params[2] || (params[3] !== null && saved.enabled !== params[3]);
      saved = { ...saved, base_url: params[1], workspace_id: params[2], enabled: params[3] ?? saved.enabled, config_revision: String(Number(saved.config_revision) + (changed ? 1 : 0)) };
      return { rows: [{ project_id: '97' }] };
    }
    if (/from project_tracemini_integrations join projects/i.test(sql)) return { rows: [saved] };
    return { rows: [] };
  } };
  const saveMod = loadTs(service, {
    './db': { ensureSchema: async () => {}, getPool: () => saveDb },
    './projects': { ProjectServiceError: class ProjectServiceError extends Error {}, projectAccessSql: () => ({ join: '', predicate: 'true' }) },
    './tracemini-adapter': { validateTraceMiniBaseUrl: (value) => value },
    './tracemini-crypto': { decryptTraceMiniCredential: () => 'credential' },
    './tracemini-normalize': {},
  });
  await saveMod.saveTraceMiniConfig(owner, '97', { baseUrl: saved.base_url, workspaceId: 'new-workspace' });
  assert.equal(saved.config_revision, '13');
  await saveMod.saveTraceMiniConfig(owner, '97', { baseUrl: saved.base_url, workspaceId: 'new-workspace' });
  assert.equal(saved.config_revision, '13', 'no-op save must not increment the revision');
  assert.ok(saveWrites.every((sql) => /config_revision[\s\S]*is distinct from/i.test(sql)));

  const row = integrationRow('96', { config_revision: '12' });
  const writes = [];
  const db = traceDb(() => row);
  const originalQuery = db.query.bind(db);
  db.query = async (sql, params = []) => {
    if (/update project_tracemini_integrations/i.test(sql)) writes.push(sql);
    return originalQuery(sql, params);
  };
  const mod = loadTraceMiniService({ db });
  const result = await mod.getTraceMiniData(engineer, '96');
  assert.equal(result.state, 'fresh');
  const statusWrites = writes.filter((sql) => /set (?:last_successful_sync|last_error)/i.test(sql));
  assert.ok(statusWrites.length > 0);
  assert.ok(statusWrites.every((sql) => !/config_revision\s*=/.test(sql.split(/\bwhere\b/i)[0])));
});

test('stale data expires after five minutes and is never served for auth/not-found failures', async () => {
  for (const code of ['temporary_outage', 'unauthorized', 'not_found']) {
    let now = 1_700_000_000_000;
    class FakeDate extends Date { constructor(value) { super(value === undefined ? now : value); } static now() { return now; } }
    let failure = null;
    const row = integrationRow('91');
    const db = traceDb(() => row);
    const mod = loadTraceMiniService({ db, DateClass: FakeDate, traceMiniGet: async (_u, _c, endpoint) => {
      if (failure) throw Object.assign(new Error('safe'), { code: failure });
      return validUpstream(endpoint);
    }, normalizeTraceMiniData: () => ({ marker: 'cached' }) });
    await mod.getTraceMiniData(engineer, '91');
    failure = code;
    now += code === 'temporary_outage' ? 300_001 : 31_000;
    const result = await mod.getTraceMiniData(engineer, '91');
    assert.equal(result.state, 'unavailable', code);
    assert.equal(result.data, null, code);
  }
});

test('cached upstream data is mapped against current project member emails on every read', async () => {
  let member = { id: '7', email: 'old@example.com', display_name: 'Old name' };
  const row = integrationRow('93');
  const db = traceDb(() => row, () => [member]);
  let upstreamCalls = 0;
  const normalizer = loadTs(normalizePath);
  const mod = loadTraceMiniService({ db, normalizeTraceMiniData: normalizer.normalizeTraceMiniData, traceMiniGet: async (_u, _c, endpoint) => {
    upstreamCalls += 1;
    if (endpoint === 'dashboard') return { events: [{ id: 'event-1', repository_id: 'linked-repository', type: 'commit', user_name: 'new@example.com', occurred_at: '2026-01-01T00:00:00Z' }], repositories: [{ id: 'linked-repository', name: 'app', normalized_remote: 'https://github.com/acme/widget.git' }], stats: {}, timeline: [] };
    return validUpstream(endpoint);
  } });
  const first = await mod.getTraceMiniData(engineer, '93');
  assert.equal(first.data.recentActivity[0].member.mapped, false);
  member = { id: '7', email: 'new@example.com', display_name: 'New name' };
  const second = await mod.getTraceMiniData(engineer, '93');
  assert.equal(second.data.recentActivity[0].member.label, 'New name');
  assert.equal(upstreamCalls, 5, 'second read must use cache while refreshing identity mapping');
});

test('concurrent cache misses for one revision share one upstream fetch', async () => {
  const row = integrationRow('94');
  const db = traceDb(() => row);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let upstreamCalls = 0;
  const mod = loadTraceMiniService({ db, traceMiniGet: async (_u, _c, endpoint) => {
    upstreamCalls += 1;
    await gate;
    return validUpstream(endpoint);
  }, normalizeTraceMiniData: () => ({ marker: 'shared' }) });
  const first = mod.getTraceMiniData(engineer, '94');
  const second = mod.getTraceMiniData(engineer, '94');
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.all([first, second]);
  assert.equal(upstreamCalls, 5);
  assert.ok(results.every((result) => result.data.marker === 'shared'));
});

test('TraceMini removal requires explicit browser confirmation', () => {
  const ui = source('app/projects/[projectId]/WorkspaceClient.tsx');
  assert.match(ui, /(?:window\.)?confirm\(/);
  assert.match(ui, /confirm[\s\S]{0,300}method:\s*'DELETE'/i);
});
