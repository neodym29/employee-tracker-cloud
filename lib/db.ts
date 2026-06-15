import { Pool } from 'pg';
import crypto from 'crypto';
import { resolve4, resolve6, resolveMx, resolveNs } from 'node:dns/promises';

let pool: Pool | null = null;

export type Health = {
  configured: boolean;
  hasIngestKey: boolean;
  databaseUrlHint: string;
};

const CONSUMER_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
]);

export function health(): Health {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  return {
    configured: Boolean(url),
    hasIngestKey: Boolean(process.env.INGEST_API_KEY),
    databaseUrlHint: url ? url.replace(/:\/\/.*@/, '://***@').replace(/\?.*$/, '?…') : 'missing',
  };
}

export function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('DATABASE_URL or POSTGRES_URL is not configured');
  if (!pool) {
    pool = new Pool({ connectionString, ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false } });
  }
  return pool;
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('Enter a valid work email');
  return normalized;
}

function domainFromEmail(email: string): string {
  return normalizeEmail(email).split('@')[1];
}

function normalizeDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase().replace(/^@+/, '').replace(/\.$/, '');
  if (!/^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(normalized)) throw new Error('Enter a valid company email domain');
  if (CONSUMER_EMAIL_DOMAINS.has(normalized)) throw new Error('Use a company-owned email domain, not a personal email provider');
  return normalized;
}

export async function assertLegitCompanyDomain(domain: string): Promise<string> {
  const normalized = normalizeDomain(domain);
  const checks = [
    resolveMx(normalized).then((records) => records.length > 0),
    resolveNs(normalized).then((records) => records.length > 0),
    resolve4(normalized).then((records) => records.length > 0),
    resolve6(normalized).then((records) => records.length > 0),
  ];
  const results = await Promise.allSettled(checks);
  if (!results.some((result) => result.status === 'fulfilled' && result.value)) {
    throw new Error(`Could not verify DNS for ${normalized}. Use a real company domain with MX, NS, A, or AAAA records.`);
  }
  return normalized;
}

function assertPassword(password: string): string {
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  return password;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.pbkdf2Sync(assertPassword(password), salt, 210_000, 32, 'sha256').toString('hex');
  return `pbkdf2_sha256$210000$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) return false;
  const [scheme, iterationsRaw, salt, expected] = storedHash.split('$');
  if (scheme !== 'pbkdf2_sha256' || !iterationsRaw || !salt || !expected) return false;
  const iterations = Number(iterationsRaw);
  if (!Number.isFinite(iterations) || iterations < 100_000) return false;
  const actual = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return expectedBuffer.length === actual.length && crypto.timingSafeEqual(expectedBuffer, actual);
}

export async function ensureSchema() {
  const db = getPool();
  await db.query(`
    create table if not exists companies (
      id bigserial primary key,
      name text not null,
      domain text not null unique,
      created_at timestamptz not null default now()
    );
    create table if not exists app_users (
      id bigserial primary key,
      company_id bigint not null references companies(id),
      email text not null unique,
      password_hash text,
      role text not null check(role in ('admin','employee')),
      approval_status text not null default 'pending' check(approval_status in ('pending','approved','rejected')),
      employee_username text,
      device_label text,
      enrollment_token text unique,
      approved_at timestamptz,
      created_at timestamptz not null default now()
    );
    create table if not exists devices (
      id bigserial primary key,
      company_id bigint not null references companies(id),
      user_id bigint references app_users(id),
      device_key text not null unique,
      employee_email text not null,
      hostname text,
      os_user text,
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now()
    );
    create table if not exists activity_events (
      id bigserial primary key,
      company_id bigint not null references companies(id),
      device_id bigint references devices(id),
      employee_email text not null,
      hostname text,
      os_user text,
      captured_at timestamptz not null,
      event_type text not null,
      app_name text,
      window_title text,
      url text,
      idle_seconds integer,
      payload jsonb not null default '{}'::jsonb,
      received_at timestamptz not null default now()
    );
    create table if not exists activity_screenshots (
      id bigserial primary key,
      activity_event_id bigint not null unique references activity_events(id) on delete cascade,
      company_id bigint not null references companies(id),
      employee_email text not null,
      captured_at timestamptz not null,
      mime_type text not null default 'image/png',
      image_base64 text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists app_settings (
      key text primary key,
      value text not null,
      updated_at timestamptz not null default now()
    );
  `);
  await db.query(`alter table app_users add column if not exists enrollment_token text unique`);
  await db.query(`alter table app_users add column if not exists approved_at timestamptz`);
  await db.query(`alter table app_users add column if not exists password_hash text`);
  await db.query(`create index if not exists idx_activity_events_received_id on activity_events (received_at desc, id desc)`);
  await db.query(`create index if not exists idx_activity_events_captured_id on activity_events (captured_at desc, id desc)`);
  await db.query(`create index if not exists idx_activity_events_employee_received on activity_events (employee_email, received_at desc, id desc)`);
  await db.query(`create index if not exists idx_activity_events_type_received on activity_events (event_type, received_at desc, id desc)`);
  await db.query(`create index if not exists idx_devices_last_seen on devices (last_seen_at desc)`);
}

export async function registerCompanyWithAdmin(companyName: string, adminEmail: string, adminPassword: string) {
  const email = normalizeEmail(adminEmail);
  const passwordHash = hashPassword(adminPassword);
  const emailDomain = domainFromEmail(email);
  const domain = await assertLegitCompanyDomain(emailDomain);
  const name = companyName.trim() || domain.split('.')[0];
  const db = getPool();
  await ensureSchema();
  const existing = await db.query(`select id from companies where domain=$1`, [domain]);
  if (existing.rows[0]) throw new Error(`${domain} is already registered. Ask an existing admin to approve employees.`);
  const company = await db.query(
    `insert into companies(name, domain) values($1,$2) returning id, name, domain`,
    [name, domain],
  );
  const user = await db.query(
    `insert into app_users(company_id,email,password_hash,role,approval_status,employee_username,approved_at)
     values($1,$2,$3,'admin','approved',$4,now())
     returning id, email, role, approval_status`,
    [company.rows[0].id, email, passwordHash, email.split('@')[0]],
  );
  return { ok: true, company: company.rows[0], admin: user.rows[0] };
}

export async function signupEmployee(email: string, password: string) {
  const normalized = normalizeEmail(email);
  const passwordHash = hashPassword(password);
  const domain = domainFromEmail(normalized);
  const db = getPool();
  await ensureSchema();
  const company = await db.query(`select id, domain from companies where domain=$1`, [domain]);
  const companyId = company.rows[0]?.id;
  if (!companyId) throw new Error(`${domain} is not registered yet. Register the company and first admin before employee signups.`);
  const signup = await db.query(
    `insert into app_users(company_id,email,password_hash,role,approval_status,employee_username)
     values($1,$2,$3,'employee','pending',$4)
     on conflict(email) do update set company_id=excluded.company_id, password_hash=excluded.password_hash, approval_status='pending', employee_username=excluded.employee_username
     where app_users.role='employee'
     returning email, role, approval_status`,
    [companyId, normalized, passwordHash, normalized.split('@')[0]],
  );
  if (!signup.rows[0]) throw new Error(`${normalized} is already an admin. Use the login page or reset admin access.`);
  return { ok: true, email: normalized, company_domain: domain, status: 'pending' };
}

export async function listEventStatsForSetup() {
  const db = getPool();
  await ensureSchema();
  const [totals, byType, recent] = await Promise.all([
    db.query(`select count(*)::int as total_events, count(*) filter (where exists(select 1 from activity_screenshots s where s.activity_event_id=activity_events.id))::int as screenshot_events, max(received_at) as latest_received_at from activity_events`),
    db.query(`select event_type, count(*)::int as count, max(received_at) as latest_received_at from activity_events group by event_type order by count desc, event_type asc`),
    db.query(`select id, employee_email, event_type, received_at, captured_at, exists(select 1 from activity_screenshots s where s.activity_event_id=activity_events.id) as has_screenshot from activity_events order by received_at desc, id desc limit 20`),
  ]);
  return { totals: totals.rows[0], by_type: byType.rows, recent: recent.rows };
}

export async function listUsersForSetup() {
  const db = getPool();
  await ensureSchema();
  const result = await db.query(
    `select app_users.email, app_users.role, app_users.approval_status, app_users.employee_username, app_users.approved_at,
      companies.domain as company_domain, app_users.password_hash is not null as has_password,
      case when app_users.enrollment_token is null then null else left(app_users.enrollment_token, 8) || '…' end as enrollment_token_hint,
      app_users.created_at
     from app_users join companies on companies.id=app_users.company_id
     order by app_users.id asc`,
  );
  return result.rows;
}

export async function telemetryPaused() {
  const db = getPool();
  await ensureSchema();
  const result = await db.query(`select value from app_settings where key='telemetry_paused' limit 1`);
  return result.rows[0]?.value === '1';
}

async function setTelemetryPaused(paused: boolean) {
  const db = getPool();
  await db.query(
    `insert into app_settings(key,value,updated_at) values('telemetry_paused',$1,now())
     on conflict(key) do update set value=excluded.value, updated_at=now()`,
    [paused ? '1' : '0'],
  );
}

export async function setTelemetryPauseForSetup(paused: boolean) {
  await ensureSchema();
  await setTelemetryPaused(paused);
  return { telemetry_paused: paused };
}

async function deleteBatch(table: 'activity_screenshots' | 'activity_events' | 'devices', limit: number) {
  const db = getPool();
  const result = await db.query(
    `with doomed as (select ctid from ${table} limit $1)
     delete from ${table} using doomed where ${table}.ctid=doomed.ctid`,
    [limit],
  );
  return result.rowCount || 0;
}

export async function wipeTelemetryBatchForSetup(limit = 10000) {
  await ensureSchema();
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 10000, 50000));
  const screenshots = await deleteBatch('activity_screenshots', boundedLimit);
  const events = await deleteBatch('activity_events', boundedLimit);
  const devices = events === 0 ? await deleteBatch('devices', boundedLimit) : 0;
  return { screenshots, events, devices, done: screenshots === 0 && events === 0 && devices === 0 };
}

export async function wipeTelemetryForSetup() {
  await setTelemetryPauseForSetup(true);
  return wipeTelemetryBatchForSetup(50000);
}

export async function restoreAdminAccess(email: string, password: string) {
  const normalized = normalizeEmail(email);
  const passwordHash = hashPassword(password);
  const domain = domainFromEmail(normalized);
  const db = getPool();
  await ensureSchema();
  const company = await db.query(`select id, domain from companies where domain=$1`, [domain]);
  if (!company.rows[0]) throw new Error(`${domain} is not registered yet`);
  const result = await db.query(
    `insert into app_users(company_id,email,password_hash,role,approval_status,employee_username,approved_at)
     values($1,$2,$3,'admin','approved',$4,now())
     on conflict(email) do update set company_id=excluded.company_id, password_hash=excluded.password_hash, role='admin', approval_status='approved', approved_at=now(), employee_username=excluded.employee_username
     returning email, role, approval_status, company_id`,
    [company.rows[0].id, normalized, passwordHash, normalized.split('@')[0]],
  );
  return result.rows[0] as { email: string; role: 'admin'; approval_status: 'approved'; company_id: string };
}

export async function resetExistingUserPassword(email: string, password: string) {
  const normalized = normalizeEmail(email);
  const passwordHash = hashPassword(password);
  const db = getPool();
  await ensureSchema();
  const result = await db.query(
    `update app_users
     set password_hash=$2, approval_status=case when role='employee' then 'approved' else approval_status end, approved_at=case when role='employee' then coalesce(approved_at, now()) else approved_at end
     where email=$1
     returning email, role, approval_status, company_id, password_hash is not null as has_password`,
    [normalized, passwordHash],
  );
  if (!result.rows[0]) throw new Error(`${normalized} was not found`);
  return result.rows[0] as { email: string; role: 'admin' | 'employee'; approval_status: string; company_id: string; has_password: boolean };
}

export async function approveEmployee(email: string) {
  const normalized = normalizeEmail(email);
  const token = crypto.randomBytes(24).toString('hex');
  const db = getPool();
  await ensureSchema();
  const result = await db.query(
    `update app_users
     set approval_status='approved', enrollment_token=coalesce(enrollment_token,$2), approved_at=now()
     where email=$1 and role='employee'
     returning email, enrollment_token, company_id`,
    [normalized, token],
  );
  if (!result.rows[0]) throw new Error('Employee not found');
  return result.rows[0] as { email: string; enrollment_token: string; company_id: string };
}

export async function userByEnrollmentToken(token: string) {
  const db = getPool();
  await ensureSchema();
  const result = await db.query(
    `select app_users.id, app_users.email, app_users.employee_username, app_users.company_id, companies.domain
     from app_users join companies on companies.id=app_users.company_id
     where enrollment_token=$1 and approval_status='approved' and role='employee'`,
    [token],
  );
  return result.rows[0] || null;
}

export async function approvedEmployeeInstallerToken(email: string, companyId: string) {
  const db = getPool();
  await ensureSchema();
  const result = await db.query(
    `select email, enrollment_token
     from app_users
     where email=$1 and company_id=$2 and approval_status='approved' and enrollment_token is not null`,
    [email.trim().toLowerCase(), companyId],
  );
  return result.rows[0] as { email: string; enrollment_token: string } | undefined;
}

export async function companyByDomain(domain: string) {
  const db = getPool();
  await ensureSchema();
  const normalized = normalizeDomain(domain);
  const result = await db.query(`select id, name, domain from companies where domain=$1`, [normalized]);
  return result.rows[0] || null;
}

export async function loginUser(email: string, password: string) {
  const normalized = normalizeEmail(email);
  const db = getPool();
  await ensureSchema();
  const result = await db.query(
    `select app_users.id, app_users.company_id, app_users.email, app_users.password_hash, app_users.role, app_users.approval_status, companies.domain as company_domain
     from app_users join companies on companies.id=app_users.company_id
     where app_users.email=$1`,
    [normalized],
  );
  const user = result.rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) throw new Error('Invalid email or password');
  if (user.role === 'employee' && user.approval_status !== 'approved') throw new Error('Employee account is pending admin approval');
  return {
    id: String(user.id),
    company_id: String(user.company_id),
    email: user.email as string,
    role: user.role as 'admin' | 'employee',
    approval_status: user.approval_status as string,
    company_domain: user.company_domain as string,
  };
}

type DashboardReadFilters = {
  mode?: 'latest' | 'range';
  user?: string;
  eventType?: string;
  startTime?: string;
  endTime?: string;
};

export async function readDashboard(filters: DashboardReadFilters = {}) {
  const db = getPool();
  await ensureSchema();

  const eventWhere: string[] = [];
  const eventParams: unknown[] = [];
  if (filters.user && filters.user !== 'all') {
    eventParams.push(filters.user);
    eventWhere.push(`employee_email = $${eventParams.length}`);
  }
  if (filters.eventType && filters.eventType !== 'all') {
    eventParams.push(filters.eventType);
    eventWhere.push(`event_type = $${eventParams.length}`);
  }
  if (filters.mode === 'range' && filters.startTime) {
    eventParams.push(filters.startTime);
    eventWhere.push(`captured_at >= $${eventParams.length}`);
  }
  if (filters.mode === 'range' && filters.endTime) {
    eventParams.push(filters.endTime);
    eventWhere.push(`captured_at <= $${eventParams.length}`);
  }
  eventParams.push(filters.mode === 'range' ? 500 : 120);
  const limitParam = eventParams.length;
  const eventSql = `select id, employee_email, hostname, os_user, captured_at, received_at, event_type, app_name, window_title, url, idle_seconds, payload,
      exists(select 1 from activity_screenshots s where s.activity_event_id = activity_events.id) as has_screenshot
    from activity_events
    ${eventWhere.length ? `where ${eventWhere.join(' and ')}` : ''}
    order by received_at desc, id desc
    limit $${limitParam}`;

  const [companies, users, devices, events] = await Promise.all([
    db.query(`select name, domain, created_at from companies order by id desc limit 25`),
    db.query(`select app_users.email, app_users.role, app_users.approval_status, app_users.employee_username, app_users.approved_at, app_users.created_at, companies.domain as company_domain, case when enrollment_token is null then null else left(enrollment_token, 8) || '…' end as enrollment_token_hint from app_users join companies on companies.id=app_users.company_id order by app_users.id desc limit 50`),
    db.query(`select employee_email, hostname, os_user, first_seen_at, last_seen_at from devices order by last_seen_at desc limit 25`),
    db.query(eventSql, eventParams),
  ]);
  return { companies: companies.rows, users: users.rows, devices: devices.rows, events: events.rows };
}
