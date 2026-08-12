begin;

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

alter table files_agent_devices add column if not exists ingest_window_started_at timestamptz not null default now();
alter table files_agent_devices add column if not exists ingest_window_count integer not null default 0 check(ingest_window_count >= 0);

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

do $$
begin
  if not exists (select 1 from pg_constraint where conname='files_agent_events_event_id_check' and conrelid='files_agent_events'::regclass) then
    alter table files_agent_events add constraint files_agent_events_event_id_check check(length(event_id) between 1 and 200);
  end if;
  if not exists (select 1 from pg_constraint where conname='files_agent_events_action_check' and conrelid='files_agent_events'::regclass) then
    alter table files_agent_events add constraint files_agent_events_action_check check(action in (
      'open_write','create','write','truncate','mkdir','rmdir','unlink',
      'rename_from','rename_to','link_from','link_to','symlink'
    ));
  end if;
  if not exists (select 1 from pg_constraint where conname='files_agent_events_path_check' and conrelid='files_agent_events'::regclass) then
    alter table files_agent_events add constraint files_agent_events_path_check check(length(path) between 1 and 4096);
  end if;
  if not exists (select 1 from pg_constraint where conname='files_agent_events_payload_check' and conrelid='files_agent_events'::regclass) then
    alter table files_agent_events add constraint files_agent_events_payload_check check(
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
    );
  end if;
end $$;

create index if not exists idx_files_agent_enrollments_expiry
  on files_agent_enrollments(expires_at);
create index if not exists idx_files_agent_devices_company_user
  on files_agent_devices(company_id,user_id,last_seen_at desc);
create index if not exists idx_files_agent_events_company_received
  on files_agent_events(company_id,received_at desc,id desc);
create index if not exists idx_files_agent_events_company_captured
  on files_agent_events(company_id,captured_at);

commit;
