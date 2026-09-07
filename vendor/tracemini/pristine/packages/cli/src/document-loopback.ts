import crypto from 'node:crypto';
import fs from 'node:fs';
import http, {type IncomingMessage, type ServerResponse} from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {generateDocumentMetadata} from './document-metadata.js';
import {loadConfig, stateDir, updateConfig, type Config, type LocalDocument} from './config.js';
import {MAX_DOCUMENT_BYTES, type ExtractedDocument} from './document-inspection.js';

export const DOCUMENT_LOOPBACK_PORT = 43127;
const nonces = new Map<string, number>();
const developmentOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
const acceptedMediaTypes = new Set([
  'application/octet-stream',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const json = (res: ServerResponse, status: number, value: unknown, origin?: string) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  if (origin) res.setHeader('access-control-allow-origin', origin);
  res.end(JSON.stringify(value));
};
const safeName = (value: string) => path.basename(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160);
const originFor = (config: Config) => { try { return new URL(config.serverUrl).origin; } catch { return ''; } };
const allowedOrigin = (req: IncomingMessage, config: Config) => {
  const origin = String(req.headers.origin || '');
  return origin && (origin === originFor(config) || developmentOrigins.has(origin)) ? origin : undefined;
};

function extractInChild(file: string, displayName: string, timeout = 90_000) {
  const worker = new URL('./document-extract-worker.js', import.meta.url);
  return new Promise<ExtractedDocument>((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=256', worker.pathname, file, displayName], {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Document extraction timed out.')); }, timeout);
    child.stdout.on('data', chunk => { if (stdout.length < 128 * 1024) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || 'Document extraction failed.'));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Document extraction returned invalid output.')); }
    });
  });
}

async function receive(req: IncomingMessage, target: string) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_DOCUMENT_BYTES) throw new Error('Document exceeds the 25 MiB limit.');
  let size = 0;
  const hash = crypto.createHash('sha256');
  const output = fs.createWriteStream(target, {flags: 'wx', mode: 0o600});
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_DOCUMENT_BYTES) throw new Error('Document exceeds the 25 MiB limit.');
      hash.update(chunk);
      if (!output.write(chunk)) await new Promise<void>(resolve => output.once('drain', () => resolve()));
    }
    if (!size) throw new Error('Document is empty.');
    await new Promise<void>((resolve, reject) => { output.once('error', reject); output.end(() => resolve()); });
    return {size, sha256: hash.digest('hex')};
  } catch (error) { output.destroy(); throw error; }
}

export function createDocumentLoopbackHandler(options: {
  load?: () => Config;
  derive?: (file: string, displayName: string) => Promise<{extracted: ExtractedDocument; metadata: Record<string, unknown>}>;
} = {}) {
  const readConfig = options.load ?? loadConfig;
  const derive = options.derive ?? (async (file, displayName) => {
    const extracted = await extractInChild(file, displayName);
    return {extracted, metadata: await generateDocumentMetadata(extracted.text, displayName)};
  });
  let processing = false;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const config = readConfig();
    const origin = allowedOrigin(req, config);
    const host = String(req.headers.host || '');
    if (!origin || !new RegExp(`^(?:127\\.0\\.0\\.1|localhost):${DOCUMENT_LOOPBACK_PORT}$`).test(host)) return json(res, 403, {error: 'local document request rejected'});
    res.setHeader('vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type,x-tracemini-nonce,x-tracemini-consent,x-tracemini-file-name,x-tracemini-workspace');
      if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('access-control-allow-private-network', 'true');
      return res.end();
    }
    const url = new URL(req.url || '/', `http://${host}`);
    if (req.method === 'GET' && url.pathname === '/v1/status') {
      const nonce = crypto.randomBytes(24).toString('base64url');
      nonces.set(nonce, Date.now() + 60_000);
      for (const [key, expiry] of nonces) if (expiry < Date.now()) nonces.delete(key);
      return json(res, 200, {ok: true, agentId: config.agentId, nonce}, origin);
    }
    if (req.method === 'GET' && url.pathname === '/v1/documents') {
      const workspaceId = Number(url.searchParams.get('workspaceId'));
      return json(res, 200, (config.documents || []).filter(document => document.workspaceId === workspaceId), origin);
    }
    const nonce = String(req.headers['x-tracemini-nonce'] || '');
    if (!nonces.has(nonce) || nonces.get(nonce)! < Date.now()) return json(res, 403, {error: 'local authorization expired; try again'}, origin);
    nonces.delete(nonce);
    if (req.method === 'POST' && url.pathname === '/v1/documents/derive-metadata') {
      if (processing) return json(res, 409, {error: 'Another document is already being analyzed.'}, origin);
      if (req.headers['x-tracemini-consent'] !== 'true') return json(res, 422, {error: 'Codex provider consent is required'}, origin);
      const workspaceId = Number(req.headers['x-tracemini-workspace']);
      let displayName = '';
      try { displayName = safeName(decodeURIComponent(String(req.headers['x-tracemini-file-name'] || ''))); } catch {}
      if (!Number.isInteger(workspaceId) || workspaceId < 1 || !displayName || !/\.(?:pdf|pptx)$/i.test(displayName)) return json(res, 422, {error: 'valid workspace and PDF/PPTX filename required'}, origin);
      const mediaType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
      if (!acceptedMediaTypes.has(mediaType)) return json(res, 415, {error: 'Only PDF and PPTX document uploads are accepted.'}, origin);
      const existing = (config.documents || []).filter(document => document.workspaceId === workspaceId);
      if (existing.length >= 5) return json(res, 409, {error: 'Remove a local document before adding another (maximum five).'}, origin);
      const currentBytes = existing.reduce((total, document) => total + document.byteSize, 0);
      const declaredBytes = Number(req.headers['content-length'] || 0);
      if (declaredBytes > 0 && currentBytes + declaredBytes > MAX_DOCUMENT_BYTES) return json(res, 413, {error: 'Active documents are limited to 25 MiB per workspace.'}, origin);
      const temporaryDirectory = path.join(stateDir(), 'document-tmp');
      fs.mkdirSync(temporaryDirectory, {recursive: true, mode: 0o700});
      const temporary = path.join(temporaryDirectory, `${crypto.randomUUID()}.upload`);
      processing = true;
      try {
        const {size: byteSize, sha256} = await receive(req, temporary);
        if (currentBytes + byteSize > MAX_DOCUMENT_BYTES) throw new Error('Active documents are limited to 25 MiB per workspace.');
        const duplicate = existing.find(document => document.sha256 === sha256);
        if (duplicate) return json(res, 200, duplicate, origin);
        const {extracted, metadata} = await derive(temporary, displayName);
        const document: LocalDocument = {localId: crypto.randomUUID(), workspaceId, displayName, format: extracted.format, mediaType: extracted.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation', byteSize, sha256, pageOrSlideCount: extracted.pageOrSlideCount, consentedAt: new Date().toISOString(), metadata: {...metadata, warnings: [...((metadata as any).warnings || []), ...extracted.warnings]}};
        updateConfig(current => { current.documents = [...(current.documents || []), document]; });
        return json(res, 201, document, origin);
      } catch (error: any) { return json(res, 422, {error: String(error?.message || error).slice(0, 500)}, origin); }
      finally { processing = false; fs.rmSync(temporary, {force: true}); }
    }
    const deletion = /^\/v1\/documents\/([a-f0-9-]+)$/.exec(url.pathname);
    if (req.method === 'DELETE' && deletion) {
      const before = (config.documents || []).length;
      updateConfig(current => { current.documents = (current.documents || []).filter(document => document.localId !== deletion[1]); });
      return before === loadConfig().documents?.length ? json(res, 404, {error: 'local document not found'}, origin) : json(res, 200, {ok: true}, origin);
    }
    return json(res, 404, {error: 'local document endpoint not found'}, origin);
  };
}

export function startDocumentLoopbackServer(config: Config, port = DOCUMENT_LOOPBACK_PORT) {
  const server = http.createServer(createDocumentLoopbackHandler({load: () => loadConfig()}));
  server.on('error', error => console.error(`TraceMini local document analysis unavailable: ${String((error as any)?.message || error)}`));
  server.listen(port, '127.0.0.1');
  return server;
}
