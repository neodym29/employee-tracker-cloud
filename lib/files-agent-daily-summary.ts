import { getPool } from './db';

export const FILES_SUMMARY_TIMEZONE = 'Asia/Karachi' as const;
const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;
const TOP_PROJECT_LIMIT = 5;

type Queryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};
type ReleasableQueryable = Queryable & { release(): void };

const DEFAULT_SUMMARY_RETENTION_DAYS = 90;

export async function ensureFilesAgentDailySummarySchema(queryable: Queryable = getPool()) {
  await queryable.query(`create table if not exists files_agent_daily_summaries (
    id bigserial primary key,
    company_id bigint not null references companies(id) on delete cascade,
    summary_date date not null,
    timezone text not null default 'Asia/Karachi',
    summary jsonb not null check(jsonb_typeof(summary)='object'),
    generated_at timestamptz not null default now(),
    unique(company_id,summary_date)
  )`);
  await queryable.query(`create index if not exists idx_files_agent_daily_summaries_company_date
    on files_agent_daily_summaries(company_id,summary_date desc)`);
}

type SummaryRow = {
  user_id: string;
  employee_email: string;
  device_id: string;
  device_label: string | null;
  action: string;
  path: string;
  agent: string;
  event_count: string | number;
};

export type FilesAgentDailySummary = {
  schemaVersion: 1;
  source: 'files_agent_events';
  bounds: ReturnType<typeof karachiDayBounds>;
  totals: { events: number; changedPaths: number; users: number; devices: number };
  users: Array<{
    userId: string;
    user: string;
    events: number;
    changedPaths: number;
    actions: Record<string, number>;
    agents: Record<string, number>;
    devices: Array<{ deviceId: string; label: string; events: number; changedPaths: number }>;
    topProjects: Array<{ label: string; events: number }>;
  }>;
  narrative: string;
  privacy: string;
};

function validDateParts(value: string): [number, number, number] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('date must be a valid YYYY-MM-DD');
  const [year, month, day] = value.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error('date must be a valid YYYY-MM-DD');
  }
  return [year, month, day];
}

function localDateInKarachi(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FILES_SUMMARY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function karachiDayBounds(date?: string, now = new Date()) {
  const selected = date || localDateInKarachi(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const [year, month, day] = validDateParts(selected);
  const startMs = Date.UTC(year, month - 1, day) - KARACHI_OFFSET_MS;
  return {
    date: selected,
    timezone: FILES_SUMMARY_TIMEZONE,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}

function increment(target: Record<string, number>, key: string, amount: number) {
  target[key] = (target[key] || 0) + amount;
}

function displayUser(email: string): string {
  const local = email.split('@')[0] || 'User';
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'User';
}

/** Returns a short project/root label, never the full path or filename. */
export function privacySafeProjectLabel(rawPath: string): string {
  const parts = rawPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const lower = parts.map((part) => part.toLowerCase());
  const marker = lower.findIndex((part) => ['work', 'workspace', 'projects', 'project', 'repos', 'repositories', 'src'].includes(part));
  let candidate = marker >= 0 && parts[marker + 1] ? parts[marker + 1] : parts[Math.max(0, parts.length - 2)];
  if (lower[0] === 'users' && marker < 0) candidate = parts[2] || 'Other';
  candidate = (candidate || 'Other').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
  return candidate || 'Other';
}

function sortedCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export async function buildFilesAgentDailySummary(
  companyId: string,
  date?: string,
  queryable: Queryable = getPool(),
): Promise<FilesAgentDailySummary> {
  if (!/^\d+$/.test(companyId)) throw new Error('company id must be numeric');
  const bounds = karachiDayBounds(date);
  const result = await queryable.query(
    `select e.user_id,u.email as employee_email,e.device_id,d.device_label,e.action,e.path,
            coalesce(nullif(e.payload->>'agent',''),nullif(d.agent_version,''),'files-agent') as agent,
            sum((e.payload->>'count')::bigint)::text as event_count
       from files_agent_events e
       join files_agent_devices d on d.id=e.device_id and d.company_id=e.company_id and d.user_id=e.user_id
       join app_users u on u.id=e.user_id and u.company_id=e.company_id
      where e.company_id=$1
        and e.captured_at >= $2::timestamptz
        and e.captured_at < $3::timestamptz
      group by e.user_id,u.email,e.device_id,d.device_label,e.action,e.path,
               coalesce(nullif(e.payload->>'agent',''),nullif(d.agent_version,''),'files-agent')
     having sum((e.payload->>'count')::bigint) > 0`,
    [companyId, bounds.start, bounds.end],
  );

  type MutableDevice = { deviceId: string; label: string; events: number; paths: Set<string> };
  type MutableUser = {
    userId: string; email: string; events: number; paths: Set<string>;
    actions: Record<string, number>; agents: Record<string, number>;
    devices: Map<string, MutableDevice>; projects: Record<string, number>;
  };
  const users = new Map<string, MutableUser>();
  const allPaths = new Set<string>();
  const allDevices = new Set<string>();
  let totalEvents = 0;

  for (const raw of result.rows as SummaryRow[]) {
    const count = Number(raw.event_count);
    if (!Number.isSafeInteger(count) || count < 1) continue;
    let user = users.get(String(raw.user_id));
    if (!user) {
      user = { userId: String(raw.user_id), email: String(raw.employee_email), events: 0, paths: new Set(), actions: {}, agents: {}, devices: new Map(), projects: {} };
      users.set(user.userId, user);
    }
    const deviceId = String(raw.device_id);
    let device = user.devices.get(deviceId);
    if (!device) {
      device = { deviceId, label: raw.device_label ? String(raw.device_label).slice(0, 80) : `Device ${deviceId}`, events: 0, paths: new Set() };
      user.devices.set(deviceId, device);
    }
    const pathKey = String(raw.path);
    user.events += count;
    device.events += count;
    totalEvents += count;
    user.paths.add(pathKey);
    device.paths.add(pathKey);
    allPaths.add(`${user.userId}:${pathKey}`);
    allDevices.add(`${user.userId}:${deviceId}`);
    increment(user.actions, String(raw.action), count);
    increment(user.agents, String(raw.agent), count);
    increment(user.projects, privacySafeProjectLabel(pathKey), count);
  }

  const outputUsers = [...users.values()].map((user) => ({
    userId: user.userId,
    user: displayUser(user.email),
    events: user.events,
    changedPaths: user.paths.size,
    actions: sortedCounts(user.actions),
    agents: sortedCounts(user.agents),
    devices: [...user.devices.values()].map((device) => ({
      deviceId: device.deviceId,
      label: device.label,
      events: device.events,
      changedPaths: device.paths.size,
    })).sort((a, b) => b.events - a.events || a.label.localeCompare(b.label)),
    topProjects: Object.entries(user.projects)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_PROJECT_LIMIT)
      .map(([label, events]) => ({ label, events })),
  })).sort((a, b) => b.events - a.events || a.user.localeCompare(b.user));

  const userLines = outputUsers.map((user) => {
    const projects = user.topProjects.map((project) => `${project.label} (${project.events})`).join(', ') || 'none';
    return `${user.user}: ${user.events} file actions across ${user.changedPaths} changed paths on ${user.devices.length} device(s); top projects: ${projects}.`;
  });
  const narrative = outputUsers.length
    ? `${bounds.date} (${bounds.timezone}) files-only summary. ${userLines.join(' ')}`
    : `${bounds.date} (${bounds.timezone}) files-only summary: no file changes recorded.`;

  return {
    schemaVersion: 1,
    source: 'files_agent_events',
    bounds,
    totals: { events: totalEvents, changedPaths: allPaths.size, users: outputUsers.length, devices: allDevices.size },
    users: outputUsers,
    narrative,
    privacy: 'Files-agent metadata only. Full paths and file names are not returned; project labels are minimized.',
  };
}

/** Removes all telemetry-derived text before a summary crosses the durable-delivery boundary. */
export function sanitizeFilesAgentDailySummary(summary: FilesAgentDailySummary): FilesAgentDailySummary {
  return {
    ...summary,
    users: summary.users.map((user) => ({
      ...user,
      user: `Employee ${user.userId}`,
      agents: Object.keys(user.agents).length ? { 'files-agent': user.events } : {} as Record<string, number>,
      devices: user.devices.map((device) => ({ ...device, label: `Device ${device.deviceId}` })),
      topProjects: user.topProjects.map((project, index) => ({ label: `Project ${index + 1}`, events: project.events })),
    })),
    narrative: `${summary.bounds.date} (${summary.bounds.timezone}) files-only summary: ${summary.totals.events} file actions across ${summary.totals.changedPaths} changed paths by ${summary.totals.users} employee(s) on ${summary.totals.devices} device(s).`,
    privacy: 'Files-agent counts only. Stored delivery excludes raw paths, filenames, email addresses, device labels, agent-provided text, and secrets.',
  };
}

function retentionDays(value?: number): number {
  const configured = value ?? Number(process.env.FILES_AGENT_SUMMARY_RETENTION_DAYS || DEFAULT_SUMMARY_RETENTION_DAYS);
  return Math.max(1, Math.min(Number.isFinite(configured) ? Math.trunc(configured) : DEFAULT_SUMMARY_RETENTION_DAYS, 3650));
}

export async function persistFilesAgentDailySummary(
  companyId: string,
  date?: string,
  queryable: Queryable = getPool(),
  keepDays?: number,
): Promise<FilesAgentDailySummary> {
  await ensureFilesAgentDailySummarySchema(queryable);
  const connect = (queryable as Queryable & { connect?: () => Promise<ReleasableQueryable> }).connect;
  const client = connect ? await connect.call(queryable) : null;
  const db = client || queryable;
  try {
    await db.query('begin');
    await db.query(`select pg_advisory_xact_lock(hashtextextended('files-agent-summary-wipe',0))`);
    const pause = await db.query(`select value from app_settings where key='telemetry_paused' limit 1`);
    if (pause.rows[0]?.value === '1') throw new Error('daily summary delivery is paused');
    const summary = sanitizeFilesAgentDailySummary(await buildFilesAgentDailySummary(companyId, date, db));
    await db.query(
      `insert into files_agent_daily_summaries(company_id,summary_date,timezone,summary,generated_at)
       values($1,$2::date,$3,$4::jsonb,now())
       on conflict(company_id,summary_date) do update
         set timezone=excluded.timezone,summary=excluded.summary,generated_at=now()`,
      [companyId, summary.bounds.date, summary.bounds.timezone, JSON.stringify(summary)],
    );
    await db.query(
      `delete from files_agent_daily_summaries
        where company_id=$1 and summary_date < current_date - ($2::int * interval '1 day')`,
      [companyId, retentionDays(keepDays)],
    );
    await db.query('commit');
    return summary;
  } catch (error) {
    await db.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client?.release();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** Validates the complete durable JSON boundary; JSONB is not trusted as a TypeScript type. */
export function isFilesAgentDailySummary(value: unknown): value is FilesAgentDailySummary {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.source !== 'files_agent_events') return false;
  const bounds = value.bounds;
  const totals = value.totals;
  if (!isRecord(bounds) || typeof bounds.date !== 'string' || bounds.timezone !== FILES_SUMMARY_TIMEZONE
    || typeof bounds.start !== 'string' || typeof bounds.end !== 'string') return false;
  if (!isRecord(totals) || !validCount(totals.events) || !validCount(totals.changedPaths)
    || !validCount(totals.users) || !validCount(totals.devices)) return false;
  if (typeof value.narrative !== 'string' || typeof value.privacy !== 'string' || !Array.isArray(value.users)) return false;
  return value.users.every((user) => {
    if (!isRecord(user) || typeof user.userId !== 'string' || typeof user.user !== 'string'
      || !validCount(user.events) || !validCount(user.changedPaths) || !isRecord(user.actions)
      || !isRecord(user.agents) || !Array.isArray(user.devices) || !Array.isArray(user.topProjects)) return false;
    const countsValid = (counts: Record<string, unknown>) => Object.values(counts).every(validCount);
    return countsValid(user.actions) && countsValid(user.agents)
      && user.devices.every((device) => isRecord(device) && typeof device.deviceId === 'string'
        && typeof device.label === 'string' && validCount(device.events) && validCount(device.changedPaths))
      && user.topProjects.every((project) => isRecord(project) && typeof project.label === 'string' && validCount(project.events));
  });
}

export async function readFilesAgentDailySummary(
  companyId: string,
  date?: string,
  queryable: Queryable = getPool(),
): Promise<FilesAgentDailySummary | null> {
  if (!/^\d+$/.test(companyId)) throw new Error('company id must be numeric');
  if (date) validDateParts(date);
  await ensureFilesAgentDailySummarySchema(queryable);
  const result = date
    ? await queryable.query(
      `select summary from files_agent_daily_summaries where company_id=$1 and summary_date=$2::date limit 1`,
      [companyId, date],
    )
    : await queryable.query(
      `select summary from files_agent_daily_summaries where company_id=$1 order by summary_date desc limit 1`,
      [companyId],
    );
  const summary = result.rows[0]?.summary;
  if (summary === undefined) return null;
  if (!isFilesAgentDailySummary(summary)) throw new Error('invalid stored daily summary');
  return summary;
}

export async function withFilesAgentSummaryWipeLock<T>(
  operation: (queryable: Queryable) => Promise<T>,
  queryable: Queryable = getPool(),
): Promise<T> {
  const connect = (queryable as Queryable & { connect?: () => Promise<ReleasableQueryable> }).connect;
  const client = connect ? await connect.call(queryable) : null;
  const db = client || queryable;
  try {
    await db.query('begin');
    await db.query(`select pg_advisory_xact_lock(hashtextextended('files-agent-summary-wipe',0))`);
    const result = await operation(db);
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client?.release();
  }
}

export async function wipeFilesAgentDailySummariesForSetup(limit = 50_000, queryable: Queryable = getPool()) {
  await ensureFilesAgentDailySummarySchema(queryable);
  const bounded = Math.max(1, Math.min(Number(limit) || 50_000, 50_000));
  const result = await queryable.query(
    `with doomed as (select id from files_agent_daily_summaries order by id limit $1)
     delete from files_agent_daily_summaries using doomed where files_agent_daily_summaries.id=doomed.id`,
    [bounded],
  );
  return result.rowCount || 0;
}
