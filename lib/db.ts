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
}

export async function registerCompanyWithAdmin(companyName: string, adminEmail: string) {
  const email = normalizeEmail(adminEmail);
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
    `insert into app_users(company_id,email,role,approval_status,employee_username,approved_at)
     values($1,$2,'admin','approved',$3,now())
     returning email, role, approval_status`,
    [company.rows[0].id, email, email.split('@')[0]],
  );
  return { ok: true, company: company.rows[0], admin: user.rows[0] };
}

export async function signupEmployee(email: string) {
  const normalized = normalizeEmail(email);
  const domain = domainFromEmail(normalized);
  const db = getPool();
  await ensureSchema();
  const company = await db.query(`select id, domain from companies where domain=$1`, [domain]);
  const companyId = company.rows[0]?.id;
  if (!companyId) throw new Error(`${domain} is not registered yet. Register the company and first admin before employee signups.`);
  await db.query(
    `insert into app_users(company_id,email,role,approval_status,employee_username)
     values($1,$2,'employee','pending',$3)
     on conflict(email) do update set role='employee', company_id=excluded.company_id, approval_status='pending', employee_username=excluded.employee_username`,
    [companyId, normalized, normalized.split('@')[0]],
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

export async function readDashboard() {
  const db = getPool();
  await ensureSchema();
  const [companies, users, devices, events] = await Promise.all([
    db.query(`select name, domain, created_at from companies order by id desc limit 25`),
    db.query(`select app_users.email, app_users.role, app_users.approval_status, app_users.employee_username, app_users.approved_at, app_users.created_at, companies.domain as company_domain, case when enrollment_token is null then null else left(enrollment_token, 8) || '…' end as enrollment_token_hint from app_users join companies on companies.id=app_users.company_id order by app_users.id desc limit 50`),
    db.query(`select employee_email, hostname, os_user, first_seen_at, last_seen_at from devices order by last_seen_at desc limit 25`),
    db.query(`select employee_email, hostname, os_user, captured_at, event_type, app_name, window_title, url, idle_seconds, payload from activity_events order by id desc limit 200`),
  ]);
  return { companies: companies.rows, users: users.rows, devices: devices.rows, events: events.rows };
}
