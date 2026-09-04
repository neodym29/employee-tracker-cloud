import { createHash } from 'node:crypto';

export type TraceMiniProgressEvent = { id: string; upstreamId?: string; evidenceEligible?: boolean; repositoryId: string; type: string; occurredAt: string; data?: Record<string, unknown> };
export type ProjectProgress = { percent: number; summary: string; version: number };
export type ProgressProposal = { percent: number; summary: string; expectedVersion: number; events: TraceMiniProgressEvent[]; newestOccurredAt: string };
const FLOORS: Record<string, number> = { clone: 20, checkout: 20, commit: 50, push: 75 };
const EVENT_ID = /^[a-z0-9][a-z0-9._:-]{0,199}$/i;
const SHA = /^[a-f0-9]{7,64}$/i;
const SHA_FIELDS = ['commitSha', 'headSha', 'remoteHeadSha'] as const;

function gitType(value: unknown): keyof typeof FLOORS | null {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9._:-]{0,99}$/i.test(value)) return null;
  const lowered = value.toLowerCase();
  if (/(?:rejected|failed|failure|error|cancelled|canceled|denied)/.test(lowered)) return null;
  const last = lowered.split(/[.:-]/).at(-1)!;
  return Object.hasOwn(FLOORS, last) ? last as keyof typeof FLOORS : null;
}
function confirmationEligibility(data: Record<string, unknown> | undefined): 'absent' | 'confirmed' | 'rejected' {
  if (!data || !Object.hasOwn(data, 'confirmation')) return 'absent';
  const confirmation = data.confirmation;
  if (confirmation === true) return 'confirmed';
  if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)) return 'rejected';
  const value = confirmation as Record<string, unknown>;
  if (value.confirmed === false || (Object.hasOwn(value, 'confirmed') && value.confirmed !== true)) return 'rejected';
  if (value.required === true && value.confirmed !== true) return 'rejected';
  const hasStatus = Object.hasOwn(value, 'status');
  if (hasStatus && typeof value.status !== 'string') return 'rejected';
  const status = hasStatus ? (value.status as string).trim().toLowerCase() : '';
  const positiveStatus = ['confirmed', 'successful', 'success'].includes(status);
  if (hasStatus && !positiveStatus) return 'rejected';
  return value.confirmed === true || positiveStatus ? 'confirmed' : 'rejected';
}
function safeRepositoryName(value: unknown) {
  const normalized = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || /(?:[a-z][a-z0-9+.-]*:\/\/|(?:token|secret|password|credential)\s*[:=]|\/(?:home|Users|var|srv)\/)/i.test(normalized)) return 'matched repository';
  return normalized.slice(0, 120);
}
function eventShas(event: TraceMiniProgressEvent) {
  return SHA_FIELDS.flatMap((field) => {
    const value = event.data?.[field];
    return typeof value === 'string' && SHA.test(value) ? [value.toLowerCase()] : [];
  }).sort();
}
function validEvent(event: TraceMiniProgressEvent, repositoryId: string) {
  // UI ids may be synthetic. Only a separately preserved stable upstream id is evidence.
  if (!event || event.evidenceEligible === false || event.repositoryId !== repositoryId || typeof event.upstreamId !== 'string' || !EVENT_ID.test(event.upstreamId)) return null;
  const type = gitType(event.type);
  const date = new Date(event.occurredAt);
  const confirmation = confirmationEligibility(event.data);
  if (!type || Number.isNaN(date.getTime()) || confirmation === 'rejected' || (type === 'push' && confirmation !== 'confirmed')) return null;
  return { ...event, upstreamId: event.upstreamId, evidenceEligible: true, type, occurredAt: date.toISOString() };
}
function uniqueEvidence(events: TraceMiniProgressEvent[], repositoryId: string) {
  const candidates = events
    .map((event) => validEvent(event, repositoryId))
    .filter((event): event is NonNullable<ReturnType<typeof validEvent>> => event !== null);
  candidates.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.upstreamId.localeCompare(b.upstreamId) || JSON.stringify(a.data || {}).localeCompare(JSON.stringify(b.data || {})));
  const ids = new Set<string>();
  const shas = new Set<string>();
  return candidates.filter((event) => {
    if (ids.has(event.upstreamId)) return false;
    const eventShaValues = eventShas(event);
    if (eventShaValues.some((sha) => shas.has(sha))) return false;
    ids.add(event.upstreamId);
    eventShaValues.forEach((sha) => shas.add(sha));
    return true;
  });
}
export function proposeProgress(current: ProjectProgress, repositoryId: string, repositoryName: string, events: TraceMiniProgressEvent[]): ProgressProposal | null {
  const qualifying = uniqueEvidence(events, repositoryId);
  if (!qualifying.length) return null;
  const latest = qualifying.at(-1)!;
  const percent = Math.min(99, Math.max(current.percent, ...qualifying.map((event) => FLOORS[event.type])));
  const countLabel = `${qualifying.length} new Git event${qualifying.length === 1 ? '' : 's'}`;
  const tail = `; latest was ${latest.type} at ${latest.occurredAt}.`;
  const prefix = `TraceMini observed ${countLabel} for `;
  const available = Math.max(1, 240 - prefix.length - tail.length);
  const summary = `${prefix}${safeRepositoryName(repositoryName).slice(0, available)}${tail}`;
  if (percent === current.percent && summary === current.summary) return null;
  return { percent, summary, expectedVersion: current.version, events: qualifying, newestOccurredAt: latest.occurredAt };
}
export function traceMiniEvidenceKey(input: { projectId: string; generation: string; revision: string; repositoryId: string; progressVersion: number; events: TraceMiniProgressEvent[] }) {
  const eventIds = [...new Set(input.events.flatMap((event) => typeof event.upstreamId === 'string' && EVENT_ID.test(event.upstreamId) ? [event.upstreamId] : []))].sort();
  const eventTypes = [...new Set(input.events.flatMap((event) => {
    const type = gitType(event.type);
    return type ? [type] : [];
  }))].sort();
  const shas = [...new Set(input.events.flatMap(eventShas))].sort();
  const contract = [input.projectId, input.generation, input.revision, input.repositoryId, input.progressVersion, { eventIds, eventTypes, shas }];
  return createHash('sha256').update(JSON.stringify(contract), 'utf8').digest('hex');
}
