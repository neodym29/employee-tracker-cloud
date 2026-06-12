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
  `);
  await db.query(`alter table app_users add column if not exists enrollment_token text unique`);
  await db.query(`alter table app_users add column if not exists approved_at timestamptz`);
  await db.query(`alter table app_users add column if not exists password_hash text`);
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
  await db.query(
    `insert into app_users(company_id,email,password_hash,role,approval_status,employee_username)
     values($1,$2,$3,'employee','pending',$4)
     on conflict(email) do update set role='employee', company_id=excluded.company_id, password_hash=excluded.password_hash, approval_status='pending', employee_username=excluded.employee_username`,
    [companyId, normalized, passwordHash, normalized.split('@')[0]],
  );
  return { ok: true, email: normalized, company_domain: domain, status: 'pending' };
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
  eventParams.push(filters.mode === 'range' ? 1000 : 300);
  const limitParam = eventParams.length;
  const eventSql = `select id, employee_email, hostname, os_user, captured_at, received_at, event_type, app_name, window_title, url, idle_seconds, payload
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
