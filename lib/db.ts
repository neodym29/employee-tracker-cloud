import { Pool } from 'pg';
import crypto from 'crypto';

let pool: Pool | null = null;

export type Health = {
  configured: boolean;
  hasIngestKey: boolean;
  databaseUrlHint: string;
};

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
  await db.query(`insert into companies(name, domain) values($1,$2) on conflict(domain) do nothing`, ['Neodym', 'neodym.ai']);
  const company = await db.query(`select id from companies where domain=$1`, ['neodym.ai']);
  const companyId = company.rows[0]?.id;
  if (companyId) {
    await db.query(`insert into app_users(company_id,email,role,approval_status) values($1,$2,'admin','approved') on conflict(email) do nothing`, [companyId, 'hello@neodym.ai']);
    await db.query(`insert into app_users(company_id,email,role,approval_status,employee_username) values($1,$2,'employee','pending','ibrahim') on conflict(email) do nothing`, [companyId, 'ibrahim@neodym.ai']);
  }
}

export async function signupEmployee(email: string) {
  const normalized = email.trim().toLowerCase();
  if (!normalized.endsWith('@neodym.ai')) throw new Error('Use a neodym.ai work email');
  const db = getPool();
  await ensureSchema();
  const company = await db.query(`select id from companies where domain=$1`, ['neodym.ai']);
  const companyId = company.rows[0].id;
  await db.query(
    `insert into app_users(company_id,email,role,approval_status,employee_username)
     values($1,$2,'employee','pending',$3)
     on conflict(email) do update set role='employee'`,
    [companyId, normalized, normalized.split('@')[0]],
  );
  return { ok: true, email: normalized, status: 'pending' };
}

export async function approveEmployee(email: string) {
  const normalized = email.trim().toLowerCase();
  const token = crypto.randomBytes(24).toString('hex');
  const db = getPool();
  await ensureSchema();
  const result = await db.query(
    `update app_users
     set approval_status='approved', enrollment_token=coalesce(enrollment_token,$2), approved_at=now()
     where email=$1 and role='employee'
     returning email, enrollment_token`,
    [normalized, token],
  );
  if (!result.rows[0]) throw new Error('Employee not found');
  return result.rows[0] as { email: string; enrollment_token: string };
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

export async function readDashboard() {
  const db = getPool();
  await ensureSchema();
  const [users, devices, events] = await Promise.all([
    db.query(`select email, role, approval_status, employee_username, approved_at, created_at, case when enrollment_token is null then null else left(enrollment_token, 8) || '…' end as enrollment_token_hint from app_users order by id desc limit 25`),
    db.query(`select employee_email, hostname, os_user, first_seen_at, last_seen_at from devices order by last_seen_at desc limit 25`),
    db.query(`select employee_email, hostname, os_user, captured_at, event_type, app_name, window_title, url, idle_seconds from activity_events order by id desc limit 50`),
  ]);
  return { users: users.rows, devices: devices.rows, events: events.rows };
}
