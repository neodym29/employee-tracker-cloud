import { timingSafeEqual } from 'node:crypto';

type Env = { ADMIN_SETUP_KEY?: string; CHAT_BACKEND_URL?: string; CHAT_BACKEND_TOKEN?: string };
/** Setup-only, fixed read-only contract. Never returns upstream content or config. */
export async function probeChatBackend(key: string, env: Env = { ADMIN_SETUP_KEY: process.env.ADMIN_SETUP_KEY, CHAT_BACKEND_URL: process.env.CHAT_BACKEND_URL, CHAT_BACKEND_TOKEN: process.env.CHAT_BACKEND_TOKEN }, transport: typeof fetch = fetch, timeoutMs = 180_000) {
  const expected = env.ADMIN_SETUP_KEY || '';
  if (!expected || Buffer.byteLength(key) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
    return Response.json({ status: 'forbidden', elapsedMs: 0, errorCode: 'forbidden' }, { status: 403 });
  }
  const started = Date.now();
  const result = (status: string, errorCode: string | null, http = 502) => Response.json({ status, elapsedMs: Date.now() - started, errorCode }, { status: http, headers: { 'cache-control': 'no-store' } });
  if (!env.CHAT_BACKEND_URL || !env.CHAT_BACKEND_TOKEN) return result('error', 'backend_unconfigured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(180_000, Math.max(1, timeoutMs)));
  try {
    if (new URL(env.CHAT_BACKEND_URL).protocol !== 'https:') return result('error', 'backend_configuration');
    const response = await transport(env.CHAT_BACKEND_URL, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${env.CHAT_BACKEND_TOKEN}`, 'content-type': 'application/json', accept: 'application/json' }, signal: controller.signal, body: JSON.stringify({ contract_version: 2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Read-only connection diagnostic. No actions. Return a short answer, actions [], requestSummary null. No project context is provided.' }, { role: 'user', content: 'Confirm the read-only chat connection is available.' }] }) });
    if (!response.ok) { await response.body?.cancel(); return result('error', `backend_http_${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) return result('error', 'backend_contract');
    let bytes = 0; const chunks: Buffer[] = [];
    try { while (true) { const {done,value} = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 64 * 1024) { await reader.cancel(); return result('error', 'backend_contract'); } chunks.push(Buffer.from(value)); } } finally { reader.releaseLock(); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value.answer !== 'string' || !value.answer.trim() || !Array.isArray(value.actions) || value.actions.length !== 0 || value.requestSummary !== null || Object.keys(value).some(k => !['answer','actions','requestSummary'].includes(k))) return result('error', 'backend_contract');
    return result('ok', null, 200);
  } catch (error) {
    const code = (error as { cause?: { code?: string } })?.cause?.code;
    return result('error', controller.signal.aborted ? 'backend_timeout' : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'backend_dns' : code === 'ECONNREFUSED' ? 'backend_refused' : code === 'UND_ERR_CONNECT_TIMEOUT' ? 'backend_connect_timeout' : 'backend_connection');
  }
  finally { clearTimeout(timer); }
}
