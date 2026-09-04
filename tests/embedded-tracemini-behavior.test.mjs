import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const localRequire = createRequire(import.meta.url);
function load(path) {
  const javascript = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, require(specifier) {
    if (specifier === './db') return { ensureSchema: async () => {}, getPool: () => ({}) };
    if (specifier === './files-agent') return { hashFilesAgentSecret: (value) => crypto.createHash('sha256').update(value).digest('hex'), FilesAgentError: class FilesAgentError extends Error {} };
    if (specifier === './auth') return {};
    return localRequire(specifier);
  }, Buffer, process, crypto });
  return module.exports;
}

test('optional report context is an explicit, bounded, metadata-only contract', () => {
  const { validateOptionalContext } = load('lib/embedded-tracemini.ts');
  const doc = { format: 'pdf', bytes: 1024, sha256: 'a'.repeat(64) };
  assert.deepEqual(JSON.parse(JSON.stringify(validateOptionalContext({ consent: true, diff: 'diff', documents: [doc] }))), { diff: 'diff', documents: [doc] });
  assert.throws(() => validateOptionalContext({ consent: true, documents: [{ ...doc, path: 'secret.pdf' }] }), /unknown|path/i);
  assert.throws(() => validateOptionalContext({ consent: true, documents: [doc, { ...doc, content: 'secret' }] }), /unknown|content/i);
  assert.throws(() => validateOptionalContext({ consent: true, documents: Array.from({ length: 6 }, () => doc) }), /5/);
  assert.throws(() => validateOptionalContext({ consent: true, documents: [{ ...doc, bytes: 25 * 1024 * 1024 + 1 }] }), /25|bounded/i);
});

test('ingest eligibility is factual and push is remote observation, never client proof', () => {
  const { normalizeEmbeddedIngest } = load('lib/embedded-tracemini-ingest.ts');
  const base = { event_key: 'event-1', agent: 'codex', run_id: 'a'.repeat(32), occurred_at: new Date().toISOString(), repository_key: 'github.com/acme/repo', provenance: {} };
  assert.throws(() => normalizeEmbeddedIngest({ events: [{ ...base, kind: 'push', push_verified: true }] }), /unknown|prohibited/i);
});

test('schedule mutation handler rejects cross-origin requests and returns private no-store responses', async () => {
  const route = read('app/api/projects/[projectId]/tracemini/schedule/route.ts');
  const javascript = ts.transpileModule(route, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, require(specifier) {
    if (specifier === 'next/server') return { NextResponse: { json(value, init) { return { value, init }; } } };
    if (specifier === '@/lib/api') return { apiErrorResponse: (e) => ({ error: e }), assertSameOrigin(request) { if (request.headers.origin !== request.nextUrl.origin) throw new Error('Invalid origin'); }, jsonBody: async () => ({}) , requireApiSession: async () => ({ id: '1' }) };
    if (specifier === '@/lib/tracemini') return { getTraceMiniSchedule: async () => null, saveTraceMiniSchedule: async () => ({ id: '1' }) };
    throw new Error(`Unexpected import ${specifier}`);
  }, process, URL });
  const request = { headers: { origin: 'https://evil.example' }, nextUrl: { origin: 'https://app.example' } };
  const response = await module.exports.PUT(request, { params: Promise.resolve({ projectId: '1' }) });
  assert.match(response.error?.message || '', /Invalid origin/);
});
