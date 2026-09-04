-- Embedded TraceMini. Additive and rollback-safe: legacy 017/018 objects remain dormant.
-- No absolute local root, source text, browser/input/audio data, or external TraceMini credential is stored.
create table if not exists tracemini_runtime_settings (
  singleton boolean primary key default true check(singleton),
  tracemini_global_pause boolean not null default false,
  tracemini_embedded_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into tracemini_runtime_settings(singleton) values(true) on conflict do nothing;

create table if not exists project_tracemini_binding_codes (
  id bigserial primary key,
  project_id bigint not null references projects(id) on delete cascade,
  requested_for_user_id bigint references app_users(id) on delete cascade,
  code_hash text not null unique check(code_hash ~ '^[a-f0-9]{64}$'),
  root_label text not null check(length(root_label) between 1 and 160 and root_label !~ '[[:cntrl:]\\/]'),
  expires_at timestamptz not null,
  used_at timestamptz,
  issued_by bigint not null references app_users(id),
  created_at timestamptz not null default now(),
  check(expires_at > created_at)
);

create table if not exists project_tracemini_roots (
  id bigserial primary key,
  project_id bigint not null references projects(id) on delete cascade,
  device_id bigint not null references files_agent_devices(id) on delete cascade,
  binding_id text not null unique check(binding_id ~ '^[A-Za-z0-9_-]{32,128}$'),
  binding_secret_hash text not null check(binding_secret_hash ~ '^[a-f0-9]{64}$'),
  root_hash text not null check(root_hash ~ '^[a-f0-9]{64}$'),
  root_label text not null check(length(root_label) between 1 and 160 and root_label !~ '[[:cntrl:]\\/]'),
  repository_key text check(repository_key is null or length(repository_key) between 1 and 1024),
  status text not null default 'approved' check(status in ('pending','approved','revoked')),
  approved_by bigint references app_users(id), approved_at timestamptz,
  last_heartbeat_at timestamptz, revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique(project_id,device_id,root_hash)
);
create index if not exists idx_project_tracemini_roots_device on project_tracemini_roots(device_id,status);
create unique index if not exists idx_project_tracemini_roots_device_hash on project_tracemini_roots(device_id,root_hash);

create table if not exists project_tracemini_events (
  id bigserial primary key,
  project_id bigint not null references projects(id) on delete cascade,
  device_id bigint not null references files_agent_devices(id) on delete cascade,
  root_id bigint not null references project_tracemini_roots(id) on delete cascade,
  event_key text not null check(length(event_key) between 1 and 200 and event_key !~ '[[:cntrl:]]'),
  kind text not null check(kind in ('file_activity','non_git','dirty','commit','branch','merge','rewrite','pull','stage','push')),
  action text check(action is null or length(action) between 1 and 64),
  agent text not null check(agent in ('hermes','codex','claude')),
  run_id text not null check(run_id ~ '^[a-f0-9]{32,64}$'),
  repository_key text check(repository_key is null or length(repository_key) between 1 and 1024),
  occurred_at timestamptz not null,
  provenance jsonb not null default '{}'::jsonb check(jsonb_typeof(provenance)='object'),
  evidence_eligible boolean not null default false,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(root_id,event_key),
  check((kind in ('commit','branch','merge','rewrite','pull','stage','push') and repository_key is not null) or kind in ('file_activity','non_git','dirty')),
  check(confirmed_at is null or evidence_eligible)
);
create index if not exists idx_project_tracemini_events_timeline on project_tracemini_events(project_id,occurred_at desc,id desc);

create table if not exists project_tracemini_reports (
  id bigserial primary key, project_id bigint not null references projects(id) on delete cascade,
  requested_by bigint not null references app_users(id), scope text not null check(scope in ('personal','workspace')),
  reporter text not null check(reporter in ('codex','hermes')), name text not null check(length(name) between 1 and 160),
  format text not null check(format in ('markdown','pdf','pptx')), prompt text check(prompt is null or octet_length(prompt)<=20000),
  start_date date not null, end_date date not null, include_diff boolean not null default false,
  documents jsonb not null default '[]'::jsonb check(jsonb_typeof(documents)='array'),
  parent_report_id bigint references project_tracemini_reports(id) on delete set null,
  status text not null default 'pending' check(status in ('pending','running','completed','failed','cancelled')),
  lease_id text, lease_expires_at timestamptz, attempt_count integer not null default 0 check(attempt_count between 0 and 10),
  last_error text check(last_error is null or length(last_error)<=2000), next_run_at timestamptz,
  dedupe_key text unique, notify_slack boolean not null default false, slack_status text not null default 'not_requested' check(slack_status in ('not_requested','pending','sent','failed')),
  markdown text check(markdown is null or octet_length(markdown)<=1048576), created_at timestamptz not null default now(), completed_at timestamptz,
  check(start_date <= end_date), check(end_date-start_date <= 366)
);
alter table project_tracemini_reports add column if not exists created_at timestamptz not null default now();
create index if not exists idx_project_tracemini_reports_history on project_tracemini_reports(project_id,created_at desc);

create table if not exists project_tracemini_schedules (
  id bigserial primary key, project_id bigint not null references projects(id) on delete cascade,
  configured_by bigint not null references app_users(id), name text not null check(length(name) between 1 and 160),
  frequency text not null check(frequency in ('daily','weekdays','selected_days')), local_time time not null,
  timezone text not null check(length(timezone) between 1 and 100), selected_days jsonb not null default '[]'::jsonb check(jsonb_typeof(selected_days)='array'),
  reporter text not null check(reporter in ('codex','hermes')), format text not null check(format in ('markdown','pdf','pptx')),
  prompt text check(prompt is null or octet_length(prompt)<=20000), include_diff boolean not null default false,
  documents jsonb not null default '[]'::jsonb check(jsonb_typeof(documents)='array'), notify_slack boolean not null default false,
  next_run_at timestamptz not null, dedupe_key text not null unique, last_run_at timestamptz,
  enabled boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists idx_project_tracemini_schedules_project on project_tracemini_schedules(project_id);
alter table project_tracemini_reports add column if not exists schedule_id bigint references project_tracemini_schedules(id) on delete set null;

-- Upgrade repair for 018 installations. CREATE IF NOT EXISTS cannot repair the
-- legacy device-bound code shape or text schedule/time format.
alter table project_tracemini_binding_codes add column if not exists requested_for_user_id bigint references app_users(id) on delete cascade;
alter table project_tracemini_binding_codes drop column if exists device_id;
alter table project_tracemini_binding_codes add column if not exists created_at timestamptz not null default now();
alter table project_tracemini_binding_codes add column if not exists root_label text not null default 'bound-root';
alter table project_tracemini_binding_codes add column if not exists expires_at timestamptz not null default now()+interval '10 minutes';
alter table project_tracemini_binding_codes add column if not exists used_at timestamptz;
alter table project_tracemini_binding_codes add column if not exists issued_by bigint references app_users(id);
alter table project_tracemini_reports add column if not exists name text not null default 'TraceMini report';
alter table project_tracemini_reports add column if not exists format text not null default 'markdown';
alter table project_tracemini_reports add column if not exists prompt text;
alter table project_tracemini_reports add column if not exists include_diff boolean not null default false;
alter table project_tracemini_reports add column if not exists documents jsonb not null default '[]'::jsonb;
alter table project_tracemini_reports add column if not exists parent_report_id bigint references project_tracemini_reports(id) on delete set null;
alter table project_tracemini_reports add column if not exists status text not null default 'pending';
alter table project_tracemini_reports add column if not exists lease_id text;
alter table project_tracemini_reports add column if not exists lease_expires_at timestamptz;
alter table project_tracemini_reports add column if not exists attempt_count integer not null default 0;
alter table project_tracemini_reports add column if not exists last_error text;
alter table project_tracemini_reports add column if not exists next_run_at timestamptz;
alter table project_tracemini_reports add column if not exists dedupe_key text;
alter table project_tracemini_reports add column if not exists slack_status text not null default 'not_requested';
alter table project_tracemini_reports add column if not exists markdown text;
alter table project_tracemini_reports add column if not exists completed_at timestamptz;
alter table project_tracemini_reports add column if not exists created_at timestamptz not null default now();
alter table project_tracemini_reports add column if not exists start_date date default current_date;
alter table project_tracemini_reports add column if not exists end_date date default current_date;
alter table project_tracemini_schedules add column if not exists selected_days jsonb not null default '[]'::jsonb;
alter table project_tracemini_schedules add column if not exists reporter text not null default 'codex';
alter table project_tracemini_schedules add column if not exists format text not null default 'markdown';
alter table project_tracemini_schedules add column if not exists prompt text;
alter table project_tracemini_schedules add column if not exists include_diff boolean not null default false;
alter table project_tracemini_schedules add column if not exists documents jsonb not null default '[]'::jsonb;
alter table project_tracemini_schedules add column if not exists notify_slack boolean not null default false;
alter table project_tracemini_schedules add column if not exists next_run_at timestamptz default now();
alter table project_tracemini_schedules add column if not exists dedupe_key text;
alter table project_tracemini_schedules add column if not exists enabled boolean not null default true;
alter table project_tracemini_schedules add column if not exists created_at timestamptz not null default now();
alter table project_tracemini_schedules add column if not exists updated_at timestamptz not null default now();
alter table project_tracemini_schedules alter column local_time type time using local_time::time;
alter table project_tracemini_reports drop constraint if exists project_tracemini_reports_format_check;
update project_tracemini_reports set format='markdown' where format in ('summary','detailed');
alter table project_tracemini_reports add constraint project_tracemini_reports_format_check check(format in ('markdown','pdf','pptx')) not valid;
alter table project_tracemini_schedules drop constraint if exists project_tracemini_schedules_format_check;
alter table project_tracemini_schedules add constraint project_tracemini_schedules_format_check check(format in ('markdown','pdf','pptx')) not valid;
create table if not exists tracemini_request_nonces(
  binding_id text not null, nonce text not null, seen_at timestamptz not null default now(),
  primary key(binding_id,nonce)
);

alter table projects add column if not exists tracemini_telemetry_paused boolean not null default true;
alter table projects add column if not exists tracemini_retention_days integer not null default 90 check(tracemini_retention_days between 1 and 3650);
alter table projects add column if not exists tracemini_resume_epoch bigint not null default 0 check(tracemini_resume_epoch >= 0);
alter table project_tracemini_events add column if not exists resume_epoch bigint not null default 0 check(resume_epoch >= 0);
create table if not exists tracemini_audit_log(id bigserial primary key, project_id bigint not null references projects(id) on delete cascade, actor_user_id bigint not null references app_users(id), action text not null check(length(action) between 1 and 80), details jsonb not null default '{}'::jsonb check(jsonb_typeof(details)='object'), created_at timestamptz not null default now());
create index if not exists idx_tracemini_audit_project_created on tracemini_audit_log(project_id,created_at desc,id desc);

-- Direct evidence mutation is forbidden. FK cascades execute in trigger depth > 1 and are allowed.
create or replace function prevent_project_tracemini_evidence_mutation() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' and pg_trigger_depth() > 1 then return old; end if;
  raise exception 'TraceMini evidence rows are immutable';
end $$;
drop trigger if exists prevent_project_tracemini_evidence_update on project_tracemini_evidence;
create trigger prevent_project_tracemini_evidence_update before update or delete on project_tracemini_evidence
for each row execute function prevent_project_tracemini_evidence_mutation();
