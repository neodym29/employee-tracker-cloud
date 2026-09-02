import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createBridge, LIMITS, runCodex } from '../scripts/project-agent-bridge.mjs';

const TOKEN = 'test-token-that-is-at-least-thirty-two-bytes-long';
const validBody = { messages: [{ role: 'user', content: 'hello' }], response_format: { type: 'json_object' } };
const validV2Body = { ...validBody, contract_version: 2 };

async function fixture(backend = async () => ({ answer: 'ok', actions: [], requestSummary: null }), options = {}) {
  const server = createBridge({ token: TOKEN, backend, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function request(url, init = {}) {
  const { headers, ...rest } = init;
  return fetch(`${url}/chat`, {
    method: 'POST',
    body: JSON.stringify(validBody),
    ...rest,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
  });
}

async function close(server) {
  server.close();
  await once(server, 'close');
}

test('serves versioned contracts so bridge-first rollout and app rollback remain safe', async () => {
  let received;
  const fileAction = { type: 'delete_file', args: { fileId: '12345678-1234-4234-8234-123456789abc', expectedVersion: 2 } };
  const progressAction = { type: 'update_project_progress', args: { percent: 50, summary: 'Half complete', expectedVersion: 2 } };
  const { server, url } = await fixture(async (messages) => { received = messages; return { answer: 'Safe answer', actions: [fileAction, progressAction], requestSummary: 'Deliverable requested.' }; });
  try {
    const legacyResponse = await request(url);
    assert.equal(legacyResponse.status, 200);
    assert.deepEqual(await legacyResponse.json(), { answer: 'Safe answer', actions: [fileAction] }, 'v1 callers cannot safely attest explicit progress intent');
    const response = await request(url, { body: JSON.stringify(validV2Body) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { answer: 'Safe answer', actions: [fileAction, progressAction], requestSummary: 'Deliverable requested.' });
    assert.deepEqual(received, validBody.messages);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally { await close(server); }
});

test('strictly gates route, method, media type, bearer token, and request shape', async () => {
  let calls = 0;
  const { server, url } = await fixture(async () => { calls += 1; return { answer: 'ok', actions: [], requestSummary: null }; });
  try {
    assert.equal((await fetch(`${url}/other`)).status, 404);
    assert.equal((await fetch(`${url}/chat`)).status, 405);
    assert.equal((await request(url, { headers: { authorization: `Bearer ${TOKEN}x` } })).status, 401);
    assert.equal((await request(url, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await request(url, { body: JSON.stringify({ ...validBody, extra: true }) })).status, 400);
    assert.equal((await request(url, { body: JSON.stringify({ ...validBody, contract_version: 1 }) })).status, 400);
    assert.equal((await request(url, { body: JSON.stringify({ ...validBody, contract_version: 2, extra: true }) })).status, 400);
    assert.equal((await request(url, { body: '{' })).status, 400);
    assert.equal(calls, 0);
  } finally { await close(server); }
});

test('rejects bodies over 128KB without invoking backend', async () => {
  let called = false;
  const { server, url } = await fixture(async () => { called = true; return { answer: 'no', actions: [], requestSummary: null }; });
  try {
    const body = JSON.stringify({ ...validBody, messages: [{ role: 'user', content: 'x'.repeat(LIMITS.body) }] });
    const response = await request(url, { body });
    assert.equal(response.status, 413);
    assert.equal(called, false);
  } finally { await close(server); }
});

test('caps concurrency at two and rejects excess work', async () => {
  const releases = [];
  const backend = () => new Promise((resolve) => releases.push(() => resolve({ answer: 'ok', actions: [], requestSummary: null })));
  const { server, url } = await fixture(backend);
  try {
    const first = request(url);
    const second = request(url);
    while (releases.length < 2) await new Promise((resolve) => setTimeout(resolve, 2));
    const excess = await request(url);
    assert.equal(excess.status, 503);
    assert.equal(releases.length, 2);
    releases.splice(0).forEach((release) => release());
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
  } finally { await close(server); }
});

test('accepts long free-form answers within the transport envelope', async () => {
  const longAnswer = 'x'.repeat(100_000);
  const long = await fixture(async () => ({ answer: longAnswer, actions: [], requestSummary: null }));
  try {
    const response = await request(long.url);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).answer.length, longAnswer.length);
  } finally { await close(long.server); }
});

test('aborts timed-out backend work and rejects malformed backend output', async () => {
  let aborted = false;
  const { server, url } = await fixture((_messages, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })), { timeoutMs: 30 });
  try {
    const response = await request(url);
    assert.equal(response.status, 504);
    assert.equal(aborted, true);
  } finally { await close(server); }

  const bad = await fixture(async () => ({ answer: 'ok', actions: [], extra: true }));
  try { assert.equal((await request(bad.url)).status, 502); } finally { await close(bad.server); }

  const badArgs = await fixture(async () => ({ answer: 'ok', actions: [{ type: 'delete_file', args: { fileId: '12345678-1234-4234-8234-123456789abc', expectedVersion: 1, unexpected: true } }], requestSummary: null }));
  try { assert.equal((await request(badArgs.url)).status, 502); } finally { await close(badArgs.server); }

  const legacy = await fixture(async () => ({ answer: 'ok', actions: [{ type: 'create_record', args: { title: 'legacy', recordType: 'note', body: '{}' } }], requestSummary: null }));
  try { assert.equal((await request(legacy.url)).status, 502); } finally { await close(legacy.server); }

  for (const requestSummary of ['', 'x'.repeat(161), 'line\nbreak']) {
    const invalidSummary = await fixture(async () => ({ answer: 'ok', actions: [], requestSummary }));
    try { assert.equal((await request(invalidSummary.url)).status, 502); } finally { await close(invalidSummary.server); }
  }
});

test('accepts only safe, bounded project action arguments', async () => {
  const actions = [
    { type: 'create_file', args: { path: 'src/report.txt', mediaType: 'text/plain', content: 'hello' } },
    { type: 'update_file', args: { fileId: '12345678-1234-4234-8234-123456789abc', expectedVersion: 1, content: '# updated' } },
    { type: 'rename_file', args: { fileId: '12345678-1234-4234-8234-123456789abc', expectedVersion: 2, path: 'docs/report.md' } },
    { type: 'delete_file', args: { fileId: '12345678-1234-4234-8234-123456789abc', expectedVersion: 3 } },
    { type: 'update_project_progress', args: { percent: 47, summary: 'Production progress confirmation passed.', expectedVersion: 1 } },
  ];
  const good = await fixture(async () => ({ answer: 'file work', actions, requestSummary: 'Deliverable requested.' }));
  try { assert.equal((await request(good.url)).status, 200); } finally { await close(good.server); }

  for (const badAction of [
    { type: 'create_file', args: { path: '../secret', mediaType: 'text/plain', content: 'x' } },
    { type: 'create_file', args: { path: '/absolute', mediaType: 'text/plain', content: 'x' } },
    { type: 'update_file', args: { fileId: '12345678-1234-4234-8234-123456789abc', expectedVersion: 0, content: 'x' } },
    { type: 'update_file', args: { fileId: '12345678-1234-4234-8234-123456789abc', expectedVersion: 1, mediaType: 'text/markdown', content: 'x' } },
    { type: 'create_file', args: { path: 'big.txt', mediaType: 'text/plain', content: 'x'.repeat(262145) } },
    { type: 'update_project_progress', args: { percent: -1, summary: 'Invalid', expectedVersion: 1 } },
    { type: 'update_project_progress', args: { percent: 101, summary: 'Invalid', expectedVersion: 1 } },
    { type: 'update_project_progress', args: { percent: 47, summary: '', expectedVersion: 1 } },
    { type: 'update_project_progress', args: { percent: 47, summary: 'x'.repeat(241), expectedVersion: 1 } },
    { type: 'update_project_progress', args: { percent: 47, summary: 'line\nbreak', expectedVersion: 1 } },
    { type: 'update_project_progress', args: { percent: 47, summary: 'Invalid', expectedVersion: 0 } },
    { type: 'update_project_progress', args: { percent: 47, summary: 'Invalid', expectedVersion: 1, extra: true } },
  ]) {
    const bad = await fixture(async () => ({ answer: 'no', actions: [badAction], requestSummary: null }));
    try { assert.equal((await request(bad.url)).status, 502); } finally { await close(bad.server); }
  }
});

test('requires a long production deadline for project prompts', () => {
  assert.equal(LIMITS.timeoutMs, 180_000);
});

test('explicit progress instructions produce evidence-based proposals without requiring the user to dictate a percentage', () => {
  const bridge = new URL('../scripts/project-agent-bridge.mjs', import.meta.url);
  return import('node:fs/promises').then(async ({ readFile }) => {
    const source = await readFile(bridge, 'utf8');
    assert.match(source, /explicitly requests overall or project progress/i);
    assert.match(source, /infer a conservative integer percentage from the authorized project evidence/i);
    assert.match(source, /start the action summary with Estimated/i);
    assert.doesNotMatch(source, /contains the exact percentage requested/i);
  });
});

test('requires a high-entropy-sized startup token', () => {
  assert.throws(() => createBridge({ token: 'short' }), /32-4096/);
});

test('fixture subprocess gets local-auth HOME but no ambient database, API, token, or sentinel secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-env-test-'));
  const fixture = join(dir, 'fixture.mjs');
  await writeFile(fixture, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nconst out=process.argv[process.argv.indexOf('--output-last-message')+1];\nwriteFileSync(out,JSON.stringify({answer:process.env.SENTINEL_BRIDGE_SECRET?'LEAKED':'safe:'+Boolean(process.env.HOME),actions:[],requestSummary:null}));\n`);
  await chmod(fixture, 0o700);
  Object.assign(process.env, { SENTINEL_BRIDGE_SECRET: 'must-not-reach-child', DATABASE_URL: 'postgres://secret', INGEST_API_KEY: 'secret', CHAT_BACKEND_TOKEN: 'secret' });
  try {
    const result = await runCodex([{ role: 'user', content: 'x' }], { codexBin: fixture, timeoutMs: 2000 });
    assert.equal(result.answer, 'safe:true');
  } finally {
    for (const name of ['SENTINEL_BRIDGE_SECRET', 'DATABASE_URL', 'INGEST_API_KEY', 'CHAT_BACKEND_TOKEN']) delete process.env[name];
    await rm(dir, { recursive: true, force: true });
  }
});
