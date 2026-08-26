import { Pool } from 'pg';
import crypto from 'crypto';
import { resolve4, resolve6, resolveMx, resolveNs } from 'node:dns/promises';

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

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
    pool = new Pool({
      connectionString,
      ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
      max: Number(process.env.DATABASE_POOL_MAX || '1'),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      statement_timeout: 30_000,
    });
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
  if (schemaReady) return schemaReady;
  schemaReady = ensureSchemaNow().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function ensureSchemaNow() {
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
      display_name text,
      account_type text,
      reviewed_at timestamptz,
      reviewed_by bigint references app_users(id),
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
    create table if not exists files_agent_enrollments (
      id bigserial primary key,
      company_id bigint not null references companies(id),
      user_id bigint not null references app_users(id),
      token_hash text not null unique,
      expires_at timestamptz not null,
      used_at timestamptz,
      created_at timestamptz not null default now()
    );
    create table if not exists files_agent_devices (
      id bigserial primary key,
      company_id bigint not null references companies(id),
      user_id bigint not null references app_users(id),
      enrollment_id bigint not null unique references files_agent_enrollments(id),
      credential_hash text not null unique,
      device_label text,
      hostname text,
      platform text,
      agent_version text,
      revoked_at timestamptz,
      ingest_window_started_at timestamptz not null default now(),
      ingest_window_count integer not null default 0 check(ingest_window_count >= 0),
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now()
    );
    create table if not exists files_agent_events (
      id bigserial primary key,
      company_id bigint not null references companies(id),
      user_id bigint not null references app_users(id),
      device_id bigint not null references files_agent_devices(id),
      event_id text not null constraint files_agent_events_event_id_check check(length(event_id) between 1 and 200),
      captured_at timestamptz not null,
      action text not null constraint files_agent_events_action_check check(action in (
        'open_write','create','write','truncate','mkdir','rmdir','unlink',
        'rename_from','rename_to','link_from','link_to','symlink'
      )),
      path text not null constraint files_agent_events_path_check check(length(path) between 1 and 4096),
      payload jsonb not null constraint files_agent_events_payload_check check(
        jsonb_typeof(payload)='object'
        and (payload - 'run_id' - 'agent' - 'bytes' - 'count')='{}'::jsonb
        and jsonb_typeof(payload->'run_id')='string'
        and length(payload->>'run_id') between 1 and 200
        and payload->>'agent' in ('hermes','codex','claude')
        and jsonb_typeof(payload->'bytes')='number'
        and (payload->>'bytes')::numeric = trunc((payload->>'bytes')::numeric)
        and (payload->>'bytes')::numeric between 0 and 1000000000000000
        and jsonb_typeof(payload->'count')='number'
        and (payload->>'count')::numeric = trunc((payload->>'count')::numeric)
        and (payload->>'count')::numeric between 0 and 1000000000
      ),
      received_at timestamptz not null default now(),
      unique(device_id, event_id)
    );
  `);
  await db.query(`alter table app_users add column if not exists enrollment_token text unique`);
  await db.query(`alter table app_users add column if not exists approved_at timestamptz`);
  await db.query(`alter table app_users add column if not exists password_hash text`);
  await db.query(`alter table app_users add column if not exists display_name text`);
  await db.query(`alter table app_users add column if not exists account_type text`);
  await db.query(`alter table app_users add column if not exists reviewed_at timestamptz`);
  await db.query(`alter table app_users add column if not exists reviewed_by bigint references app_users(id)`);
  await db.query(`update app_users set account_type=case when role='admin' then 'admin' else 'engineer' end where account_type is null`);
  await db.query(`update app_users set display_name=coalesce(nullif(employee_username,''),split_part(email,'@',1)) where display_name is null`);
  await db.query(`alter table app_users alter column account_type set not null`);
  await db.query(`alter table app_users alter column display_name set not null`);
  await db.query(`alter table files_agent_devices add column if not exists ingest_window_started_at timestamptz not null default now()`);
  await db.query(`alter table files_agent_devices add column if not exists ingest_window_count integer not null default 0 check(ingest_window_count >= 0)`);
  await db.query(`
    do $$ begin
      if not exists (select 1 from pg_constraint where conname='files_agent_events_event_id_check' and conrelid='files_agent_events'::regclass) then
        alter table files_agent_events add constraint files_agent_events_event_id_check check(length(event_id) between 1 and 200);
      end if;
      if not exists (select 1 from pg_constraint where conname='files_agent_events_action_check' and conrelid='files_agent_events'::regclass) then
        alter table files_agent_events add constraint files_agent_events_action_check check(action in ('open_write','create','write','truncate','mkdir','rmdir','unlink','rename_from','rename_to','link_from','link_to','symlink'));
      end if;
      if not exists (select 1 from pg_constraint where conname='files_agent_events_path_check' and conrelid='files_agent_events'::regclass) then
        alter table files_agent_events add constraint files_agent_events_path_check check(length(path) between 1 and 4096);
      end if;
      if not exists (select 1 from pg_constraint where conname='files_agent_events_payload_check' and conrelid='files_agent_events'::regclass) then
        alter table files_agent_events add constraint files_agent_events_payload_check check(jsonb_typeof(payload)='object' and (payload - 'run_id' - 'agent' - 'bytes' - 'count')='{}'::jsonb and jsonb_typeof(payload->'run_id')='string' and length(payload->>'run_id') between 1 and 200 and payload->>'agent' in ('hermes','codex','claude') and jsonb_typeof(payload->'bytes')='number' and (payload->>'bytes')::numeric=trunc((payload->>'bytes')::numeric) and (payload->>'bytes')::numeric between 0 and 1000000000000000 and jsonb_typeof(payload->'count')='number' and (payload->>'count')::numeric=trunc((payload->>'count')::numeric) and (payload->>'count')::numeric between 0 and 1000000000);
      end if;
    end $$;
  `);
  await db.query(`create index if not exists idx_files_agent_enrollments_expiry on files_agent_enrollments (expires_at)`);
  await db.query(`create index if not exists idx_files_agent_devices_company_user on files_agent_devices (company_id, user_id, last_seen_at desc)`);
  await db.query(`create index if not exists idx_files_agent_events_company_received on files_agent_events (company_id, received_at desc, id desc)`);
  await db.query(`
    do $$ begin
      if not exists (select 1 from pg_constraint where conname='app_users_account_type_check') then
        alter table app_users add constraint app_users_account_type_check check(account_type in ('admin','client','engineer'));
      end if;
    end $$;
    create table if not exists projects (
      id bigserial primary key, client_id bigint not null references app_users(id),
      title text not null check(length(title) between 1 and 120), description text not null default '' check(length(description)<=4000),
      status text not null default 'draft' check(status in ('draft','open','active','completed','archived')),
      creation_request_key uuid, creation_requested_by bigint references app_users(id),
      creation_payload_fingerprint text check(creation_payload_fingerprint is null or creation_payload_fingerprint ~ '^[a-f0-9]{64}$'),
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create table if not exists project_memberships (
      id bigserial primary key, project_id bigint not null references projects(id) on delete cascade, user_id bigint not null references app_users(id),
      membership_type text not null check(membership_type in ('invitation','request','creator')), membership_status text not null default 'pending' check(membership_status in ('pending','active','declined','rejected')),
      created_by bigint not null references app_users(id), responded_by bigint references app_users(id), created_at timestamptz not null default now(), responded_at timestamptz,
      unique(project_id,user_id)
    );
    create table if not exists project_records (
      id bigserial primary key, project_id bigint not null references projects(id) on delete cascade, record_id text not null, version integer not null check(version>0),
      title text not null check(length(title) between 1 and 160), body jsonb not null, created_by bigint not null references app_users(id), created_at timestamptz not null default now(),
      unique(project_id,record_id,version)
    );
    create table if not exists project_artifacts (
      id bigserial primary key, project_id bigint not null references projects(id) on delete cascade,
      filename text not null check(length(filename) between 1 and 255), media_type text not null check(length(media_type) between 1 and 255),
      size_bytes bigint not null check(size_bytes>=0 and size_bytes<=1000000000000), sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
      storage_key text check(storage_key is null or length(storage_key)<=1024), created_by bigint not null references app_users(id), created_at timestamptz not null default now()
    );
    create table if not exists project_files (
      id bigserial primary key, project_id bigint not null references projects(id) on delete cascade,
      file_id text not null check(file_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
      version integer not null check(version > 0),
      path text not null check(length(path) between 1 and 1024 and path !~ '^/' and path !~ '\\\\' and path !~ '[[:cntrl:]]' and path ~ '^[^/]+(/[^/]+)*$' and path !~ '(^|/)\\.{1,2}(/|$)'),
      media_type text not null check(length(media_type) between 1 and 255), content text not null check(octet_length(content) <= 262144),
      byte_size integer not null check(byte_size >= 0 and byte_size <= 262144 and byte_size = octet_length(content)),
      sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'), created_by bigint not null references app_users(id), created_at timestamptz not null default now(),
      unique(project_id,file_id,version)
    );
    alter table project_files drop constraint if exists project_files_project_id_path_version_key;
    create table if not exists project_file_heads (
      project_id bigint not null references projects(id) on delete cascade, file_id text not null,
      current_version integer not null check(current_version>0),
      path text not null check(length(path) between 1 and 1024 and path !~ '^/' and path !~ '\\\\' and path !~ '[[:cntrl:]]' and path ~ '^[^/]+(/[^/]+)*$' and path !~ '(^|/)\\.{1,2}(/|$)'),
      media_type text not null check(length(media_type) between 1 and 255), byte_size integer not null check(byte_size>=0 and byte_size<=262144),
      sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'), deleted_at timestamptz, updated_at timestamptz not null default now(),
      primary key(project_id,file_id),
      foreign key(project_id,file_id,current_version) references project_files(project_id,file_id,version) deferrable initially deferred
    );
    create table if not exists project_chat_messages (
      id bigserial primary key, project_id bigint not null references projects(id) on delete cascade, user_id bigint references app_users(id),
      role text not null check(role in ('user','assistant','system')), body text not null, created_at timestamptz not null default now()
    );
    create table if not exists project_agent_actions (
      id bigserial primary key, project_id bigint not null references projects(id) on delete cascade, actor_user_id bigint references app_users(id),
      action_type text not null, input jsonb not null default '{}'::jsonb, output jsonb,
      status text not null default 'pending' check(status in ('pending','confirmed','cancelled')),
      confirmed_by bigint references app_users(id), confirmed_at timestamptz, result jsonb,
      created_at timestamptz not null default now()
    );
    alter table project_agent_actions add column if not exists status text not null default 'pending';
    alter table project_agent_actions add column if not exists confirmed_by bigint references app_users(id);
    alter table project_agent_actions add column if not exists confirmed_at timestamptz;
    alter table project_agent_actions add column if not exists result jsonb;
    alter table projects add column if not exists creation_request_key uuid;
    alter table projects add column if not exists creation_requested_by bigint references app_users(id);
    alter table projects add column if not exists creation_payload_fingerprint text;
    do $$
    declare membership_constraint text;
    begin
      for membership_constraint in
        select conname from pg_constraint
        where conrelid='project_memberships'::regclass and contype='c'
          and pg_get_constraintdef(oid) ilike '%membership_type%'
          and pg_get_constraintdef(oid) not ilike '%creator%'
      loop
        execute format('alter table project_memberships drop constraint %I',membership_constraint);
      end loop;
      if not exists (
        select 1 from pg_constraint where conrelid='project_memberships'::regclass and contype='c'
          and pg_get_constraintdef(oid) ilike '%membership_type%creator%'
      ) then
        alter table project_memberships add constraint project_memberships_membership_type_check
          check(membership_type in ('invitation','request','creator'));
      end if;
      if not exists (select 1 from pg_constraint where conname='projects_creation_request_unique' and conrelid='projects'::regclass) then
        alter table projects add constraint projects_creation_request_unique unique(creation_requested_by,creation_request_key);
      end if;
      if not exists (select 1 from pg_constraint where conname='projects_creation_payload_fingerprint_check' and conrelid='projects'::regclass) then
        alter table projects add constraint projects_creation_payload_fingerprint_check check(creation_payload_fingerprint is null or creation_payload_fingerprint ~ '^[a-f0-9]{64}$');
      end if;
    end $$;

    do $$ begin
      if not exists (select 1 from pg_constraint where conname='project_agent_actions_status_check') then
        alter table project_agent_actions add constraint project_agent_actions_status_check check(status in ('pending','confirmed','cancelled'));
      end if;
    end $$;
    create index if not exists idx_app_users_approval_type on app_users (approval_status,account_type,id);
    create index if not exists idx_projects_client_status on projects (client_id,status,updated_at desc);
    create index if not exists idx_projects_open on projects (updated_at desc,id) where status='open';
    create index if not exists idx_project_memberships_user_status on project_memberships (user_id,membership_status,project_id);
    create index if not exists idx_project_memberships_project_status on project_memberships (project_id,membership_status,id);
    create index if not exists idx_project_records_latest on project_records (project_id,record_id,version desc);
    create index if not exists idx_project_artifacts_project on project_artifacts (project_id,created_at desc,id desc);
    create index if not exists idx_project_files_latest on project_files (project_id,file_id,version desc);
    create index if not exists idx_project_files_path_latest on project_files (project_id,path,version desc);
    create unique index if not exists project_file_heads_active_path_unique on project_file_heads(project_id,path) where deleted_at is null;
    create index if not exists idx_project_chat_project on project_chat_messages (project_id,created_at,id);
    create index if not exists idx_project_agent_actions_project on project_agent_actions (project_id,created_at,id);
  `);
  await db.query(`
    insert into project_file_heads(project_id,file_id,current_version,path,media_type,byte_size,sha256,deleted_at,updated_at)
    select project_id,file_id,version,path,media_type,byte_size,sha256,
      case when media_type='application/x.project-tombstone' then created_at else null end,created_at
    from (select distinct on(project_id,file_id) * from project_files order by project_id,file_id,version desc) latest
    on conflict(project_id,file_id) do nothing;
    do $$ begin
      if exists (select 1 from pg_constraint where conname='project_file_heads_project_id_fkey' and confdeltype='c') then
        alter table project_file_heads drop constraint project_file_heads_project_id_fkey;
        alter table project_file_heads add constraint project_file_heads_project_id_fkey foreign key(project_id) references projects(id) on delete restrict;
      end if;
      if exists (select 1 from pg_constraint where conname='project_files_project_id_fkey' and confdeltype='c') then
        alter table project_files drop constraint project_files_project_id_fkey;
        alter table project_files add constraint project_files_project_id_fkey foreign key(project_id) references projects(id) on delete restrict;
      end if;
      if exists (select 1 from pg_constraint where conname='project_agent_actions_project_id_fkey' and confdeltype='c') then
        alter table project_agent_actions drop constraint project_agent_actions_project_id_fkey;
        alter table project_agent_actions add constraint project_agent_actions_project_id_fkey foreign key(project_id) references projects(id) on delete restrict;
      end if;
    end $$;
    create or replace function prevent_project_file_version_mutation() returns trigger language plpgsql as $$
    begin raise exception 'project file version rows are immutable'; end $$;
    drop trigger if exists prevent_project_file_version_update on project_files;
    create trigger prevent_project_file_version_update before update or delete on project_files
      for each row execute function prevent_project_file_version_mutation();
    do $$ begin
      if not exists (select 1 from pg_constraint where conname='project_agent_actions_actor_not_null') then
        alter table project_agent_actions add constraint project_agent_actions_actor_not_null check(actor_user_id is not null) not valid;
      end if;
    end $$;
    create or replace function prevent_project_agent_action_mutation() returns trigger language plpgsql as $$
    begin
      if tg_op='DELETE' then raise exception 'project agent action audit rows are immutable'; end if;
      if old.status='pending' and new.status in ('confirmed','cancelled')
         and new.id=old.id and new.project_id=old.project_id and new.actor_user_id is not distinct from old.actor_user_id
         and new.action_type=old.action_type and new.input=old.input and new.created_at=old.created_at
         and new.output is not distinct from old.output and new.confirmed_by=old.actor_user_id
         and new.confirmed_at is not null and new.result is not null then
        return new;
      end if;
      raise exception 'project agent action audit rows are immutable';
    end $$;
    drop trigger if exists prevent_project_agent_action_update on project_agent_actions;
    create trigger prevent_project_agent_action_update before update or delete on project_agent_actions
      for each row execute function prevent_project_agent_action_mutation();
    create index if not exists idx_project_agent_actions_pending on project_agent_actions(project_id,id) where status='pending';
  `);
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
    `insert into app_users(company_id,email,password_hash,role,approval_status,employee_username,approved_at,display_name,account_type)
     values($1,$2,$3,'admin','approved',$4,now(),$5,'client')
     returning id, email, role, approval_status`,
    [company.rows[0].id, email, passwordHash, email.split('@')[0], name],
  );
  return { ok: true, company: company.rows[0], admin: user.rows[0] };
}

export async function signupAccount(accountType: 'client' | 'engineer', displayName: string, email: string, password: string) {
  const normalized = normalizeEmail(email);
  if (accountType !== 'client' && accountType !== 'engineer') throw new Error('Choose client or engineer');
  const name = displayName.trim();
  if (!name || name.length > 120) throw new Error('Display name must be between 1 and 120 characters');
  const passwordHash = hashPassword(password);
  const db = getPool();
  await ensureSchema();
  const company = await db.query(
    `insert into companies(name,domain) values('Platform Accounts','platform.local')
     on conflict(domain) do update set name=companies.name returning id`,
  );
  const signup = await db.query(
    `insert into app_users(company_id,email,password_hash,role,approval_status,employee_username,display_name,account_type)
     values($1,$2,$3,'employee','pending',$4,$5,$6)
     on conflict(email) do nothing
     returning email, account_type, approval_status`,
    [company.rows[0].id, normalized, passwordHash, normalized.split('@')[0], name, accountType],
  );
  if (!signup.rows[0]) throw new Error('Account could not be created');
  return { ok: true, email: normalized, account_type: accountType, status: 'pending' };
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
    `insert into app_users(company_id,email,password_hash,role,approval_status,employee_username,display_name,account_type)
     values($1,$2,$3,'employee','pending',$4,$4,'engineer')
     on conflict(email) do nothing
     returning email, role, account_type, approval_status`,
    [companyId, normalized, passwordHash, normalized.split('@')[0]],
  );
  if (!signup.rows[0]) throw new Error('Account could not be created');
  return { ok: true, email: normalized, company_domain: domain, account_type: 'engineer' as const, status: 'pending' as const };
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

async function deleteBatch(table: 'activity_screenshots' | 'activity_events' | 'devices' | 'files_agent_events' | 'files_agent_devices' | 'files_agent_enrollments', limit: number) {
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
  const filesAgentEvents = await deleteBatch('files_agent_events', boundedLimit);
  const filesAgentDevices = filesAgentEvents === 0 ? await deleteBatch('files_agent_devices', boundedLimit) : 0;
  const filesAgentEnrollments = filesAgentEvents === 0 && filesAgentDevices === 0 ? await deleteBatch('files_agent_enrollments', boundedLimit) : 0;
  const devices = events === 0 ? await deleteBatch('devices', boundedLimit) : 0;
  return {
    screenshots, events, devices,
    files_agent_events: filesAgentEvents,
    files_agent_devices: filesAgentDevices,
    files_agent_enrollments: filesAgentEnrollments,
    done: screenshots === 0 && events === 0 && devices === 0 && filesAgentEvents === 0 && filesAgentDevices === 0 && filesAgentEnrollments === 0,
  };
}

export async function wipeTelemetryForSetup() {
  await setTelemetryPauseForSetup(true);
  return wipeTelemetryBatchForSetup(50000);
}

export async function repairTelemetrySequencesForSetup() {
  const db = getPool();
  await ensureSchema();
  const tables = ['companies', 'app_users', 'devices', 'activity_events', 'activity_screenshots'] as const;
  for (const table of tables) {
    await db.query(`select setval(pg_get_serial_sequence($1, 'id'), coalesce((select max(id) from ${table}), 0) + 1, false)`, [table]);
  }
  return { repaired: tables };
}

export async function optimizeTelemetryIndexesForSetup() {
  const db = getPool();
  await ensureSchema();
  await db.query(`create index if not exists idx_activity_events_received_id on activity_events (received_at desc, id desc)`);
  await db.query(`create index if not exists idx_activity_events_employee_received on activity_events (employee_email, received_at desc, id desc)`);
  await db.query(`create index if not exists idx_activity_events_type_received on activity_events (event_type, received_at desc, id desc)`);
  await db.query(`create index if not exists idx_devices_last_seen on devices (last_seen_at desc)`);
  return { optimized: true };
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
    `insert into app_users(company_id,email,password_hash,role,approval_status,employee_username,approved_at,display_name,account_type)
     values($1,$2,$3,'admin','approved',$4,now(),$4,'admin')
     on conflict(email) do update set company_id=excluded.company_id, password_hash=excluded.password_hash, role='admin', account_type='admin', approval_status='approved', approved_at=now(), employee_username=excluded.employee_username
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

export async function approveEmployee(email: string, companyId?: string) {
  const normalized = normalizeEmail(email);
  const token = crypto.randomBytes(24).toString('hex');
  const db = getPool();
  await ensureSchema();
  const result = await db.query(
    `update app_users
     set approval_status='approved', enrollment_token=coalesce(enrollment_token,$2), approved_at=now()
     where email=$1 and role='employee' and ($3::bigint is null or company_id=$3)
     returning email, enrollment_token, company_id`,
    [normalized, token, companyId || null],
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
     where enrollment_token=$1 and approval_status='approved'`,
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
    `select app_users.id, app_users.company_id, app_users.email, app_users.password_hash, app_users.role, app_users.account_type, app_users.approval_status, companies.domain as company_domain
     from app_users join companies on companies.id=app_users.company_id
     where app_users.email=$1`,
    [normalized],
  );
  const user = result.rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) throw new Error('Invalid email or password');
  if (user.approval_status !== 'approved') throw new Error('Account is not approved');
  return {
    id: String(user.id),
    company_id: String(user.company_id),
    email: user.email as string,
    role: user.role as 'admin' | 'employee',
    account_type: user.account_type as 'admin' | 'client' | 'engineer',
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

export async function readDashboard(filters: DashboardReadFilters, companyId: string) {
  const db = getPool();
  await ensureSchema();

  const allPortalUsersSql = `select app_users.id, app_users.email, app_users.role, app_users.approval_status, app_users.employee_username, app_users.approved_at, app_users.created_at, app_users.enrollment_token, companies.domain as company_domain
    from app_users join companies on companies.id=app_users.company_id
    where app_users.company_id=$1`;
  const enrolledPortalUsersSql = `${allPortalUsersSql}
    and app_users.approval_status='approved' and app_users.enrollment_token is not null`;

  const eventWhere: string[] = [];
  const eventParams: unknown[] = [companyId];
  if (filters.user && filters.user !== 'all') {
    eventParams.push(filters.user);
    eventWhere.push(`activity_events.employee_email = $${eventParams.length}`);
  }
  if (filters.eventType && filters.eventType !== 'all') {
    eventParams.push(filters.eventType);
    eventWhere.push(`activity_events.event_type = $${eventParams.length}`);
  }
  if (filters.mode === 'range' && filters.startTime) {
    eventParams.push(filters.startTime);
    eventWhere.push(`activity_events.captured_at >= $${eventParams.length}`);
  }
  if (filters.mode === 'range' && filters.endTime) {
    eventParams.push(filters.endTime);
    eventWhere.push(`activity_events.captured_at <= $${eventParams.length}`);
  }
  eventParams.push(filters.mode === 'range' ? 500 : 120);
  const limitParam = eventParams.length;
  const eventSql = `with portal_users as (${enrolledPortalUsersSql})
    select activity_events.id, activity_events.employee_email, activity_events.hostname, activity_events.os_user, activity_events.captured_at, activity_events.received_at, activity_events.event_type, activity_events.app_name, activity_events.window_title, activity_events.url, activity_events.idle_seconds, activity_events.payload,
      exists(select 1 from activity_screenshots s where s.activity_event_id = activity_events.id)
        or exists(select 1 from activity_screenshots s where s.activity_event_id = case when (activity_events.payload->>'source_event_id') ~ '^\\d+$' then (activity_events.payload->>'source_event_id')::bigint end)
        as has_screenshot
    from activity_events
    join portal_users on portal_users.email = activity_events.employee_email
    ${eventWhere.length ? `where ${eventWhere.join(' and ')}` : ''}
    order by activity_events.received_at desc, activity_events.id desc
    limit $${limitParam}`;

  const fileWhere: string[] = [];
  const fileParams: unknown[] = [companyId];
  fileWhere.push(`files_agent_events.company_id=$1`);
  if (filters.user && filters.user !== 'all') {
    fileParams.push(filters.user);
    fileWhere.push(`app_users.email=$${fileParams.length}`);
  }
  if (filters.eventType && filters.eventType !== 'all' && filters.eventType !== 'ai_file_change') fileWhere.push('false');
  if (filters.mode === 'range' && filters.startTime) {
    fileParams.push(filters.startTime);
    fileWhere.push(`files_agent_events.captured_at >= $${fileParams.length}`);
  }
  if (filters.mode === 'range' && filters.endTime) {
    fileParams.push(filters.endTime);
    fileWhere.push(`files_agent_events.captured_at <= $${fileParams.length}`);
  }
  fileParams.push(filters.mode === 'range' ? 500 : 120);
  const filesEventSql = `select 'f-' || files_agent_events.id::text as id, app_users.email as employee_email,
      files_agent_devices.hostname, null::text as os_user, files_agent_events.captured_at, files_agent_events.received_at,
      'ai_file_change'::text as event_type, 'AI files tracker'::text as app_name,
      files_agent_events.path as window_title, null::text as url, null::integer as idle_seconds,
      files_agent_events.payload || jsonb_build_object(
        'action', files_agent_events.action, 'path', files_agent_events.path,
        'agent', coalesce(files_agent_events.payload->>'agent', files_agent_devices.agent_version, 'files-agent'),
        'device', coalesce(files_agent_devices.device_label, files_agent_devices.hostname, files_agent_devices.id::text),
        'device_id', files_agent_devices.id
      ) as payload, false as has_screenshot
    from files_agent_events
    join files_agent_devices on files_agent_devices.id=files_agent_events.device_id and files_agent_devices.company_id=files_agent_events.company_id
    join app_users on app_users.id=files_agent_events.user_id and app_users.company_id=files_agent_events.company_id
    ${fileWhere.length ? `where ${fileWhere.join(' and ')}` : ''}
    order by files_agent_events.received_at desc, files_agent_events.id desc
    limit $${fileParams.length}`;

  const [companies, users, devices, events, fileEvents, fileDevices] = await Promise.all([
    db.query(`select name, domain, created_at from companies where id=$1 order by id desc limit 25`, [companyId]),
    db.query(`select email, role, approval_status, employee_username, approved_at, created_at, company_domain, case when enrollment_token is null then null else left(enrollment_token, 8) || '…' end as enrollment_token_hint from (${allPortalUsersSql}) portal_users order by id desc limit 50`, [companyId]),
    db.query(`with portal_users as (${enrolledPortalUsersSql}) select devices.employee_email, devices.hostname, devices.os_user, devices.first_seen_at, devices.last_seen_at from devices join portal_users on portal_users.email = devices.employee_email order by devices.last_seen_at desc limit 25`, [companyId]),
    db.query(eventSql, eventParams),
    db.query(filesEventSql, fileParams),
    db.query(`select app_users.email as employee_email, files_agent_devices.hostname,
      coalesce(files_agent_devices.device_label, files_agent_devices.platform, 'files-agent') as os_user,
      files_agent_devices.created_at as first_seen_at, files_agent_devices.last_seen_at
      from files_agent_devices join app_users on app_users.id=files_agent_devices.user_id and app_users.company_id=files_agent_devices.company_id
      where files_agent_devices.company_id=$1
      order by files_agent_devices.last_seen_at desc limit 25`, [companyId]),
  ]);
  const mergedEvents = [...events.rows, ...fileEvents.rows]
    .sort((left, right) => new Date(right.received_at).getTime() - new Date(left.received_at).getTime())
    .slice(0, filters.mode === 'range' ? 500 : 120);
  const mergedDevices = [...fileDevices.rows, ...devices.rows].slice(0, 50);
  return { companies: companies.rows, users: users.rows, devices: mergedDevices, events: mergedEvents };
}
