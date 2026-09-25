begin;

alter table projects add column if not exists progress_source text;

-- Existing assessed values predate plugin estimates and must remain human-owned.
-- Null progress remains eligible for a conservative automatic estimate.
update projects
set progress_source=case when progress_percent is null then 'unassessed' else 'manual' end
where progress_source is null;

alter table projects alter column progress_source set default 'unassessed';
alter table projects alter column progress_source set not null;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname='projects_progress_source_check' and conrelid='projects'::regclass
  ) then
    alter table projects add constraint projects_progress_source_check
      check(progress_source in ('unassessed','manual','plugin_daily'));
  end if;
end $$;

create table if not exists codex_plugin_daily_runs (
  id bigserial primary key,
  project_id bigint not null references projects(id) on delete cascade,
  device_id bigint not null references files_agent_devices(id) on delete cascade,
  company_id bigint not null references companies(id) on delete cascade,
  user_id bigint not null references app_users(id) on delete cascade,
  summary_date date not null,
  status text not null default 'running'
    check(status in ('running','completed','failed')),
  report_id bigint references project_tracemini_reports(id) on delete set null,
  event_count integer not null default 0 check(event_count >= 0),
  attempt_count integer not null default 1 check(attempt_count between 1 and 3),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error text check(last_error is null or length(last_error) <= 240),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id,user_id,summary_date)
);

create index if not exists idx_codex_plugin_daily_owner
  on codex_plugin_daily_runs(company_id,user_id,summary_date desc,updated_at desc);
create index if not exists idx_codex_plugin_daily_device
  on codex_plugin_daily_runs(device_id,summary_date desc,updated_at desc);

commit;
