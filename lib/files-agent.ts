import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import type { SessionUser } from './auth';
import { getPool } from './db';

const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const MAX_EVENTS = 250;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const ENROLLMENT_RATE_PER_HOUR = 5;
const DEVICE_LIMIT_PER_USER = 10;
const INGEST_RATE_EVENTS_PER_MINUTE = 5_000;
const MAX_BYTES = 1_000_000_000_000_000;
const MAX_COUNT = 1_000_000_000;
const INGEST_FIELDS = new Set(['events', 'device_id']);
const IDENTITY_FIELDS = new Set(['employee_email', 'email', 'company_id', 'company_domain', 'user_id']);
const EVENT_FIELDS = new Set(['id', 'event_id', 'run_id', 'agent', 'action', 'path', 'bytes', 'count', 'occurred_at', 'captured_at']);
const DEVICE_DETAIL_FIELDS = new Set(['device_label', 'hostname', 'platform', 'agent_version']);
const FILE_AGENTS = new Set(['hermes', 'codex', 'claude']);
const FILE_ACTIONS = new Set([
  'open_write', 'create', 'write', 'truncate', 'mkdir', 'rmdir', 'unlink',
  'rename_from', 'rename_to', 'link_from', 'link_to', 'symlink',
]);

export class FilesAgentError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

export function hashFilesAgentSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

function randomSecret(prefix: 'fae' | 'fad'): string {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

function boundedString(value: unknown, name: string, max: number, required = false): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new FilesAgentError(`${name} is required`, 400);
  if (text.length > max) throw new FilesAgentError(`${name} is too long`, 400);
  return text;
}

function boundedIdentifier(value: unknown, name: string, max: number): string {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!text) throw new FilesAgentError(`${name} is required`, 400);
  if (text.length > max) throw new FilesAgentError(`${name} is too long`, 400);
  return text;
}

function assertExactFields(value: Record<string, unknown>, allowed: Set<string>, context: string) {
  const field = Object.keys(value).find((key) => !allowed.has(key));
  if (field && IDENTITY_FIELDS.has(field.toLowerCase())) {
    throw new FilesAgentError(`${context} must not specify identity (${field})`, 400);
  }
  if (field) throw new FilesAgentError(`${context} contains unknown or prohibited field (${field})`, 400);
}

function boundedNonnegativeInteger(value: unknown, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new FilesAgentError(`${name} must be a nonnegative integer no greater than ${max}`, 400);
  }
  return value;
}

function oneOf(value: string, allowed: Set<string>, name: string): string {
  if (!allowed.has(value)) throw new FilesAgentError(`${name} is not allowed`, 400);
  return value;
}

export function bearerSecret(request: Request): string {
  const authorization = request.headers.get('authorization') || '';
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  return match?.[1] || '';
}

export function requireSecureFilesAgentOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FilesAgentError('invalid files-agent application URL', 500);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !local && process.env.NODE_ENV === 'production') {
    throw new FilesAgentError('files-agent enrollment URL must use HTTPS', 500);
  }
  return url.origin;
}

export async function createFilesAgentEnrollment(user: SessionUser) {
  const token = randomSecret('fae');
  const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);
  const result = await getPool().query(
    `with guard as materialized (
       select pg_advisory_xact_lock(id) from app_users where id=$1 and company_id=$2
     )
     insert into files_agent_enrollments(company_id,user_id,token_hash,expires_at)
     select company_id,id,$3,$4 from app_users cross join guard
     where id=$1 and company_id=$2 and email=$5 and approval_status='approved'
       and (select count(*) from files_agent_enrollments recent
            where recent.user_id=app_users.id and recent.company_id=app_users.company_id
              and recent.created_at > now() - interval '1 hour') < $6
     returning id, expires_at`,
    [user.id, user.company_id, hashFilesAgentSecret(token), expiresAt, user.email, ENROLLMENT_RATE_PER_HOUR],
  );
  if (!result.rows[0]) throw new FilesAgentError('approved login required or enrollment_rate exceeded', 429);
  return { token, expires_at: new Date(result.rows[0].expires_at).toISOString() };
}

type DeviceDetails = {
  device_label?: unknown;
  hostname?: unknown;
  platform?: unknown;
  agent_version?: unknown;
};

export async function exchangeFilesAgentEnrollment(token: string, details: DeviceDetails) {
  if (!token.startsWith('fae_')) throw new FilesAgentError('invalid or expired enrollment token', 403);
  assertExactFields(details as Record<string, unknown>, DEVICE_DETAIL_FIELDS, 'request');
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('begin');
    const enrollment = await client.query(
      `select e.id,e.company_id,e.user_id
       from files_agent_enrollments e
       join app_users u on u.id=e.user_id and u.company_id=e.company_id
       where e.token_hash=$1 and e.used_at is null and e.expires_at > now()
         and u.approval_status='approved'
       for update of e`,
      [hashFilesAgentSecret(token)],
    );
    const row = enrollment.rows[0];
    if (!row) throw new FilesAgentError('invalid or expired enrollment token', 403);

    // Serialize device-cap checks for this user so concurrent enrollment exchanges cannot bypass the limit.
    await client.query(`select pg_advisory_xact_lock($1::bigint)`, [row.user_id]);
    const activeDevices = await client.query(
      `select count(*)::int as count from files_agent_devices
       where company_id=$1 and user_id=$2 and revoked_at is null`,
      [row.company_id, row.user_id],
    );
    if (Number(activeDevices.rows[0]?.count || 0) >= DEVICE_LIMIT_PER_USER) {
      throw new FilesAgentError('device_limit exceeded; revoke an existing device first', 429);
    }

    const credential = randomSecret('fad');
    const device = await client.query(
      `insert into files_agent_devices(
         company_id,user_id,enrollment_id,credential_hash,device_label,hostname,platform,agent_version
       ) values($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [
        row.company_id,
        row.user_id,
        row.id,
        hashFilesAgentSecret(credential),
        boundedString(details.device_label, 'device_label', 200),
        boundedString(details.hostname, 'hostname', 255),
        boundedString(details.platform, 'platform', 100),
        boundedString(details.agent_version, 'agent_version', 100),
      ],
    );
    await client.query(`update files_agent_enrollments set used_at=now() where id=$1`, [row.id]);
    await client.query('commit');
    return { device_id: String(device.rows[0].id), device_credential: credential };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

type FileEvent = Record<string, unknown>;

type NormalizedFileEvent = {
  eventId: string;
  capturedAt: string;
  action: string;
  path: string;
  payload: Record<string, unknown>;
};

export function normalizeFilesAgentEvents(body: Record<string, unknown>): NormalizedFileEvent[] {
  assertExactFields(body, INGEST_FIELDS, 'request');
  if ('device_id' in body) boundedString(body.device_id, 'device_id', 200, true);
  if (!Array.isArray(body.events) || body.events.length === 0) throw new FilesAgentError('events must be a non-empty array', 400);
  if (body.events.length > MAX_EVENTS) throw new FilesAgentError(`at most ${MAX_EVENTS} events are allowed`, 400);
  return body.events.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new FilesAgentError(`events[${index}] must be an object`, 400);
    const event = raw as FileEvent;
    assertExactFields(event, EVENT_FIELDS, `events[${index}]`);
    if ('id' in event && 'event_id' in event) throw new FilesAgentError(`events[${index}] must specify only one of id or event_id`, 400);
    if ('occurred_at' in event && 'captured_at' in event) throw new FilesAgentError(`events[${index}] must specify only one timestamp`, 400);
    const eventId = boundedIdentifier(event.event_id ?? event.id, `events[${index}].event_id`, 200);
    const runId = boundedString(event.run_id, `events[${index}].run_id`, 200, true);
    const agent = oneOf(boundedString(event.agent, `events[${index}].agent`, 20, true), FILE_AGENTS, `events[${index}].agent`);
    const action = oneOf(boundedString(event.action, `events[${index}].action`, 100, true), FILE_ACTIONS, `events[${index}].action`);
    const path = boundedString(event.path, `events[${index}].path`, 4096, true);
    const capturedAt = boundedString(event.captured_at ?? event.occurred_at, `events[${index}].captured_at`, 100, true);
    const bytes = boundedNonnegativeInteger(event.bytes, `events[${index}].bytes`, MAX_BYTES);
    const count = boundedNonnegativeInteger(event.count, `events[${index}].count`, MAX_COUNT);
    const timestamp = new Date(capturedAt);
    if (Number.isNaN(timestamp.getTime())) throw new FilesAgentError(`events[${index}].captured_at is invalid`, 400);
    const skew = timestamp.getTime() - Date.now();
    if (skew > MAX_EVENT_FUTURE_SKEW_MS || skew < -MAX_EVENT_AGE_MS) {
      throw new FilesAgentError(`events[${index}].captured_at is outside the allowed time window`, 400);
    }
    const payload = { run_id: runId, agent, bytes, count };
    return { eventId, capturedAt: timestamp.toISOString(), action, path, payload };
  });
}

export async function ingestFilesAgentEvents(credential: string, body: Record<string, unknown>) {
  if (!credential.startsWith('fad_')) throw new FilesAgentError('invalid device credential', 401);
  const events = normalizeFilesAgentEvents(body);
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const pause = await client.query(`select value from app_settings where key='telemetry_paused' for share`);
    if (pause.rows[0]?.value === '1') throw new FilesAgentError('telemetry temporarily paused for reset', 503);
    const deviceResult = await client.query(
      `select d.id,d.company_id,d.user_id
       from files_agent_devices d
       join app_users u on u.id=d.user_id and u.company_id=d.company_id
       where d.credential_hash=$1 and d.revoked_at is null and u.approval_status='approved'
       for update of d`,
      [hashFilesAgentSecret(credential)],
    );
    const device = deviceResult.rows[0];
    if (!device) throw new FilesAgentError('invalid or revoked device credential', 401);

    const ingestRate = await client.query(
      `update files_agent_devices
       set ingest_window_started_at=case when ingest_window_started_at <= now() - interval '1 minute' then now() else ingest_window_started_at end,
           ingest_window_count=case when ingest_window_started_at <= now() - interval '1 minute' then $2 else ingest_window_count + $2 end
       where id=$1
         and (ingest_window_started_at <= now() - interval '1 minute' or ingest_window_count + $2 <= $3)
       returning id`,
      [device.id, events.length, INGEST_RATE_EVENTS_PER_MINUTE],
    );
    if (!ingestRate.rows[0]) throw new FilesAgentError('ingest_rate exceeded; retry later', 429);

    let accepted = 0;
    for (const event of events) {
      const result = await insertFileEvent(client, device, event);
      accepted += result;
    }
    await client.query(`update files_agent_devices set last_seen_at=now() where id=$1`, [device.id]);
    await client.query('commit');
    return { accepted, duplicates: events.length - accepted, received: events.length };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export type FilesAgentDevice = {
  id: string;
  user_id: string;
  owner_email: string;
  device_label: string | null;
  hostname: string | null;
  platform: string | null;
  agent_version: string | null;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
};

function serializeDevice(row: Record<string, unknown>): FilesAgentDevice {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    owner_email: String(row.owner_email),
    device_label: typeof row.device_label === 'string' ? row.device_label : null,
    hostname: typeof row.hostname === 'string' ? row.hostname : null,
    platform: typeof row.platform === 'string' ? row.platform : null,
    agent_version: typeof row.agent_version === 'string' ? row.agent_version : null,
    created_at: new Date(String(row.created_at)).toISOString(),
    last_seen_at: new Date(String(row.last_seen_at)).toISOString(),
    revoked_at: row.revoked_at ? new Date(String(row.revoked_at)).toISOString() : null,
  };
}

export async function listFilesAgentDevices(user: SessionUser): Promise<FilesAgentDevice[]> {
  const result = await getPool().query(
    `select d.id,d.user_id,u.email as owner_email,d.device_label,d.hostname,d.platform,d.agent_version,
            d.created_at,d.last_seen_at,d.revoked_at
     from files_agent_devices d
     join app_users u on u.id=d.user_id and u.company_id=d.company_id
     where d.company_id=$1 and ($2::boolean or d.user_id=$3)
     order by d.revoked_at nulls first,d.last_seen_at desc,d.id desc`,
    [user.company_id, user.role === 'admin', user.id],
  );
  return result.rows.map(serializeDevice);
}

export async function revokeFilesAgentDevice(user: SessionUser, deviceId: string): Promise<FilesAgentDevice> {
  if (!/^\d+$/.test(deviceId)) throw new FilesAgentError('invalid device id', 400);
  const result = await getPool().query(
    `update files_agent_devices d
     set revoked_at=coalesce(d.revoked_at,now())
     from app_users u
     where d.id=$1 and d.company_id=$2 and u.id=d.user_id and u.company_id=d.company_id
       and ($3::boolean or d.user_id=$4)
     returning d.id,d.user_id,u.email as owner_email,d.device_label,d.hostname,d.platform,d.agent_version,
               d.created_at,d.last_seen_at,d.revoked_at`,
    [deviceId, user.company_id, user.role === 'admin', user.id],
  );
  if (!result.rows[0]) throw new FilesAgentError('device not found', 404);
  return serializeDevice(result.rows[0]);
}

async function insertFileEvent(client: PoolClient, device: { id: string; company_id: string; user_id: string }, event: NormalizedFileEvent) {
  const result = await client.query(
    `insert into files_agent_events(company_id,user_id,device_id,event_id,captured_at,action,path,payload)
     values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     on conflict(device_id,event_id) do nothing`,
    [device.company_id, device.user_id, device.id, event.eventId, event.capturedAt, event.action, event.path, JSON.stringify(event.payload)],
  );
  return result.rowCount || 0;
}

export async function cleanupFilesAgentRetention(limit = 10_000) {
  const retentionDays = Math.max(1, Math.min(Number(process.env.FILES_AGENT_RETENTION_DAYS || '90') || 90, 3650));
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 10_000, 50_000));
  const db = getPool();
  const events = await db.query(
    `with doomed as (
       select id from files_agent_events
       where received_at < now() - ($1::int * interval '1 day')
       order by received_at,id limit $2
     ) delete from files_agent_events using doomed where files_agent_events.id=doomed.id`,
    [retentionDays, boundedLimit],
  );
  const enrollments = await db.query(
    `with doomed as (
       select e.id from files_agent_enrollments e
       where e.expires_at < now() - interval '1 day'
         and not exists(select 1 from files_agent_devices d where d.enrollment_id=e.id)
       order by e.expires_at,e.id limit $1
     ) delete from files_agent_enrollments using doomed where files_agent_enrollments.id=doomed.id`,
    [boundedLimit],
  );
  return { events: events.rowCount || 0, enrollments: enrollments.rowCount || 0, retention_days: retentionDays };
}

export function filesAgentHttpError(error: unknown): { message: string; status: number } {
  if (error instanceof FilesAgentError) return { message: error.message, status: error.status };
  console.error('files-agent request failed', error);
  if (process.env.FILES_AGENT_DEBUG_ERRORS === '1') {
    return { message: error instanceof Error ? error.message : String(error), status: 500 };
  }
  return { message: 'internal server error', status: 500 };
}
