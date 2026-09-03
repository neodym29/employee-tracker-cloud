export type TraceMiniProjectMember = { id: string; email: string; display_name?: string | null };
export type SafeMember = { mapped: boolean; id?: string; label: string };

const UNMAPPED = 'Unmapped TraceMini member';
const SAFE_CONFIRMATION_STATUSES = new Set(['confirmed', 'unconfirmed', 'pending', 'required', 'not_required', 'approved', 'rejected']);

function text(value: unknown, limit = 240): string {
  const normalized = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  // Upstream display strings are untrusted: do not pass through any remote URL,
  // absolute/traversal path, SCP-style Git remote, or recognizable auth header.
  if (
    /\b[a-z][a-z0-9+.-]*:\/\//i.test(normalized)
    || /(?:^|[\s('\"=])(?:\/(?!\/)[^\s]+|[a-z]:\\|\\\\|\.\.\/)/i.test(normalized)
    || /\b(?:git|ssh)@[^\s:]+:[^\s]+/i.test(normalized)
    || /\b(?:cookie|set-cookie|authorization)\s*:/i.test(normalized)
    || /\b(?:bearer|token|secret|credential)\s*[:=]\s*\S+/i.test(normalized)
  ) return '[redacted]';
  return normalized;
}

function timestamp(value: unknown): string {
  const date = new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function safeNumber(value: unknown): number | undefined {
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function safeConfirmation(value: unknown): unknown {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value === 'string') return SAFE_CONFIRMATION_STATUSES.has(value) ? value : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  if (typeof input.confirmed === 'boolean') output.confirmed = input.confirmed;
  if (typeof input.required === 'boolean') output.required = input.required;
  if (typeof input.status === 'string' && SAFE_CONFIRMATION_STATUSES.has(input.status)) output.status = input.status;
  if (Number.isSafeInteger(input.attempts) && Number(input.attempts) >= 0) output.attempts = input.attempts;
  return Object.keys(output).length ? output : undefined;
}

export function mapTraceMiniIdentity(value: unknown, members: TraceMiniProjectMember[]): SafeMember {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const member = candidate && candidate.includes('@') ? members.find((item) => item.email.trim().toLowerCase() === candidate) : undefined;
  return member ? { mapped: true, id: String(member.id), label: text(member.display_name || member.email, 120) } : { mapped: false, label: UNMAPPED };
}

function eventData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ['filesChanged', 'insertions', 'deletions'] as const) {
    const number = safeNumber(input[key]);
    if (number !== undefined) output[key] = number;
  }
  if (Array.isArray(input.stagedFiles)) output.stagedFiles = input.stagedFiles.length;
  else { const count = safeNumber(input.stagedFiles); if (count !== undefined) output.stagedFiles = count; }
  for (const key of ['commitSha', 'headSha', 'remoteHeadSha'] as const) {
    if (typeof input[key] === 'string' && /^[a-f0-9]{7,64}$/i.test(input[key])) output[key] = input[key];
  }
  const confirmation = safeConfirmation(input.confirmation);
  if (confirmation !== undefined) output.confirmation = confirmation;
  return output;
}

function safeIdentifier(value: unknown, fallback = ''): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,99}$/i.test(value)) return fallback;
  if (/^eyJ[a-z0-9_-]*\.eyJ[a-z0-9_-]*\.[a-z0-9_-]+$/i.test(value) || /^(?:sk[-_]|gh[pousr]_)/i.test(value) || /(?:password|api[_-]?key|secret|token)/i.test(value)) return fallback;
  return value;
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)).slice(0, 500) : [];
}

export function normalizeTraceMiniData(input: { activity?: unknown; repositories?: unknown; agents?: unknown; reports?: unknown; dashboard?: unknown }, members: TraceMiniProjectMember[]) {
  const activity = rows(input.activity).map((event, index) => ({
    id: `activity-${index}`,
    type: safeIdentifier(event.type, 'unknown'),
    occurredAt: timestamp(event.occurred_at),
    repositoryName: safeIdentifier(event.repository_name),
    member: mapTraceMiniIdentity(event.user_name, members),
    data: eventData(event.data),
  })).filter((event) => event.occurredAt).slice(0, 100);

  const repositories = rows(input.repositories).slice(0, 100).map((repository, index) => ({
    id: `repository-${index}`,
    name: safeIdentifier(repository.name, `Repository ${index + 1}`),
    archived: repository.archived === true,
    cloneCount: safeNumber(repository.clone_count) ?? 0,
    createdAt: timestamp(repository.created_at),
  }));

  const devices = rows(input.agents).slice(0, 100).map((agent) => ({
    member: mapTraceMiniIdentity(agent.user_name, members),
    status: ['online', 'offline', 'active', 'idle', 'revoked'].includes(String(agent.status)) ? String(agent.status) : (agent.revoked_at ? 'revoked' : 'unknown'),
    lastSeen: timestamp(agent.last_seen),
  }));

  const reports = rows(input.reports).slice(0, 100).map((report, index) => ({
    id: `report-${index}`,
    title: `Report ${index + 1}`,
    status: ['available', 'pending', 'complete', 'completed', 'failed', 'archived'].includes(String(report.status)) ? String(report.status) : '',
    createdAt: timestamp(report.created_at),
    updatedAt: timestamp(report.updated_at),
  }));

  const grouped = new Map<string, { member: SafeMember; count: number }>();
  for (const item of [...activity, ...devices]) {
    const key = item.member.mapped ? `member:${item.member.id}` : 'unmapped';
    const current = grouped.get(key);
    if (current) current.count += 'type' in item ? 1 : 0;
    else grouped.set(key, { member: item.member, count: 'type' in item ? 1 : 0 });
  }

  return {
    activityTotal: rows(input.activity).length,
    recentActivity: activity,
    repositories,
    devices,
    memberActivity: [...grouped.values()],
    reports,
  };
}
