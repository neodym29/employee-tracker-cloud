import crypto from 'node:crypto';

const MAX_DIFF_BYTES = 10_000;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const SAFE_FORMATS = new Set(['pdf', 'pptx']);
const SAFE_KINDS = new Set(['git', 'non_git', 'dirty']);

export type EmbeddedRoot = { projectId: string; rootHash: string; rootPath?: string; deviceId?: string };

function canonicalPath(value: string): string {
  const path = value.trim().replaceAll('\\', '/').replace(/\/+/g, '/');
  if (!path || path.includes('\0') || !path.startsWith('/')) throw new Error('absolute local root required');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw new Error('path escapes root'); parts.pop(); }
    else parts.push(part);
  }
  return `/${parts.join('/')}` || '/';
}

export function rootBindingHash(rootPath: string, bindingCode = crypto.randomBytes(32).toString('hex')): string {
  // A path digest is predictable and cannot authorize a device. The server-issued
  // one-use code scopes this proof to one approval and one checkout.
  return crypto.createHmac('sha256', bindingCode).update(canonicalPath(rootPath), 'utf8').digest('hex');
}

export function createRootBinding(input: { projectId: string; deviceId: string; rootPath: string }): EmbeddedRoot {
  if (!/^\d+$/.test(input.projectId) || !/^\d+$/.test(input.deviceId)) throw new Error('invalid binding identity');
  return { projectId: input.projectId, deviceId: input.deviceId, rootHash: rootBindingHash(input.rootPath) };
}

export function selectProjectForPath(observedPath: string, roots: EmbeddedRoot[], claimedProjectId?: string): EmbeddedRoot {
  const observed = canonicalPath(observedPath);
  const matches = roots.filter((root) => root.rootPath && (observed === canonicalPath(root.rootPath) || observed.startsWith(`${canonicalPath(root.rootPath)}/`)));
  if (claimedProjectId && (!matches.length || !matches.some((root) => root.projectId === claimedProjectId))) throw new Error('client project identity is not authoritative');
  const selected = matches.sort((a, b) => canonicalPath(b.rootPath!).length - canonicalPath(a.rootPath!).length)[0];
  if (!selected) throw new Error('no approved project root contains observed path');
  return selected;
}

export function normalizeEmbeddedEvent(input: { kind: string; observedPath: string; repositoryKey?: string; occurredAt: string }, binding: EmbeddedRoot) {
  if (!SAFE_KINDS.has(input.kind)) throw new Error('unsupported provenance kind');
  if (!binding.projectId || !binding.deviceId || !binding.rootHash) throw new Error('incomplete approved binding');
  const occurred = new Date(input.occurredAt);
  if (Number.isNaN(occurred.getTime())) throw new Error('invalid event timestamp');
  if (input.kind === 'git' && (!input.repositoryKey || input.repositoryKey.length > 1024)) throw new Error('Git provenance requires a repository key');
  return { kind: input.kind, projectId: binding.projectId, deviceId: binding.deviceId, rootHash: binding.rootHash, repositoryKey: input.repositoryKey ?? null, occurredAt: occurred.toISOString() };
}

export function progressFromEvents(_events: unknown[]): null { return null; }

export function canCreateEvidence(input: { actorId: string; ownerId: string; confirmed: boolean }): boolean {
  return input.confirmed === true && input.actorId === input.ownerId;
}

export function validateOptionalContext(input: { diff?: string; consent?: boolean; document?: { format: string; bytes: number; sha256: string; [key: string]: unknown }; documents?: Array<{ format: string; bytes: number; sha256: string; [key: string]: unknown }> }) {
  if (input.diff !== undefined && input.consent !== true) throw new Error('bounded diff requires explicit consent');
  if (input.diff !== undefined && Buffer.byteLength(input.diff, 'utf8') > MAX_DIFF_BYTES) throw new Error('diff context is bounded');
  const documents = input.documents ?? (input.document ? [input.document] : undefined);
  if (documents !== undefined) {
    if (!Array.isArray(documents) || documents.length > 5) throw new Error('at most 5 bounded documents are allowed');
    for (const document of documents) {
      if (!document || typeof document !== 'object' || Object.keys(document).some((key) => !['format', 'bytes', 'sha256'].includes(key))) throw new Error('document paths, content, and unknown fields are prohibited');
      if (!SAFE_FORMATS.has(document.format) || !Number.isSafeInteger(document.bytes) || document.bytes < 0 || document.bytes > MAX_DOCUMENT_BYTES || !/^[a-f0-9]{64}$/.test(document.sha256)) throw new Error('invalid bounded document context');
    }
  }
  if ('token' in input || 'webhook' in input) throw new Error('Slack configuration must come from environment');
  return { ...(input.diff !== undefined ? { diff: input.diff } : {}), ...(documents ? { documents } : {}) };
}

export function validateSlackConfig(input: Record<string, unknown>) {
  if ('token' in input || 'webhook' in input || Object.keys(input).length) throw new Error('Slack configuration must come from environment');
  return { enabled: Boolean(process.env.SLACK_WEBHOOK_URL) };
}
