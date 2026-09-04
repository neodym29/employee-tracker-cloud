import 'server-only';

const MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 8_000;
const TRANSIENT_STATUS = new Set([502, 503, 504]);
const BODY_CANCEL_TIMEOUT_MS = 100;

export class TraceMiniUpstreamError extends Error {
  constructor(message: string, public transient = false, public code: TraceMiniErrorCode = 'unavailable') { super(message); }
}

export type TraceMiniErrorCode = 'timeout' | 'unauthorized' | 'not_found' | 'malformed_response' | 'too_large' | 'temporary_outage' | 'unavailable';

function configuredOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const raw of (process.env.TRACEMINI_ALLOWED_ORIGINS || '').split(',')) {
    const value = raw.trim();
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) continue;
      if (parsed.protocol !== 'https:' && !(process.env.NODE_ENV === 'development' && parsed.protocol === 'http:' && isLoopback(parsed.hostname))) continue;
      origins.add(parsed.origin);
    } catch { /* Invalid configuration cannot broaden access. */ }
  }
  return origins;
}

function isLoopback(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function validateTraceMiniBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid TraceMini base URL');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Invalid TraceMini base URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Invalid TraceMini base URL');
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('TraceMini base URL must be an origin without path, credentials, query, or hash');
  if (parsed.protocol !== 'https:' && !(process.env.NODE_ENV === 'development' && isLoopback(parsed.hostname))) throw new Error('TraceMini base URL must use HTTPS');
  if (!configuredOrigins().has(parsed.origin)) throw new Error('TraceMini origin is not trusted');
  return parsed.origin;
}

const ENDPOINTS = {
  bootstrap: () => '/api/bootstrap',
  dashboard: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/dashboard`,
  settings: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/settings`,
  agents: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/agents`,
  reports: (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/reports`,
} as const;
export type TraceMiniEndpoint = keyof typeof ENDPOINTS;

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new TraceMiniUpstreamError('TraceMini response was too large', false, 'too_large');
  if (!response.body) throw new TraceMiniUpstreamError('Invalid TraceMini response', false, 'malformed_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new TraceMiniUpstreamError('TraceMini response was too large', false, 'too_large'); }
    chunks.push(value);
  }
  const joined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  try {
    const parsed = JSON.parse(joined.toString('utf8'));
    if (parsed === null || (typeof parsed !== 'object')) throw new Error();
    return parsed;
  } catch { throw new TraceMiniUpstreamError('Invalid TraceMini response: malformed JSON', false, 'malformed_response'); }
}

async function cancelBody(response: Response) {
  if (!response.body) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => response.body!.cancel()).catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, BODY_CANCEL_TIMEOUT_MS); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function traceMiniGet(baseUrl: string, userSession: string, endpoint: TraceMiniEndpoint, workspaceId?: string, options: { timeoutMs?: number } = {}): Promise<unknown> {
  const origin = validateTraceMiniBaseUrl(baseUrl);
  if (!(endpoint in ENDPOINTS)) throw new Error('Invalid TraceMini endpoint');
  if (endpoint !== 'bootstrap' && (!workspaceId || workspaceId.length > 200)) throw new Error('Invalid TraceMini workspace ID');
  const path = endpoint === 'bootstrap' ? ENDPOINTS.bootstrap() : ENDPOINTS[endpoint](workspaceId!);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(`${origin}${path}`, { method: 'GET', headers: { authorization: `Bearer ${userSession}`, accept: 'application/json' }, signal: controller.signal, redirect: 'error', cache: 'no-store' });
      if (!response.ok) {
        controller.abort();
        await cancelBody(response);
        const transient = TRANSIENT_STATUS.has(response.status);
        if (transient && attempt < 1) continue;
        if (transient) throw new TraceMiniUpstreamError('TraceMini is temporarily unavailable', true, 'temporary_outage');
        if (response.status === 401 || response.status === 403) throw new TraceMiniUpstreamError('TraceMini authorization failed', false, 'unauthorized');
        if (response.status === 404) throw new TraceMiniUpstreamError('TraceMini resource was not found', false, 'not_found');
        throw new TraceMiniUpstreamError('TraceMini is unavailable');
      }
      return await readBoundedJson(response);
    } catch (error) {
      if (error instanceof TraceMiniUpstreamError) throw error;
      const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
      if (attempt < 1 && (error instanceof TypeError || name === 'TypeError' || name === 'AbortError')) continue;
      throw new TraceMiniUpstreamError(name === 'AbortError' ? 'TraceMini request timed out' : 'TraceMini is temporarily unavailable', true, name === 'AbortError' ? 'timeout' : 'temporary_outage');
    } finally { clearTimeout(timer); }
  }
  throw new TraceMiniUpstreamError('TraceMini is unavailable', true);
}
