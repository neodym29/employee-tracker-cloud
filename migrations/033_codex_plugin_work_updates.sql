begin;

create table if not exists codex_plugin_work_updates (
  id bigserial primary key,
  project_id bigint not null references projects(id) on delete cascade,
  device_id bigint not null references files_agent_devices(id) on delete cascade,
  company_id bigint not null references companies(id) on delete cascade,
  user_id bigint not null references app_users(id) on delete cascade,
  update_date date not null default ((now() at time zone 'Asia/Karachi')::date),
  status text not null check(status in ('in_progress','completed','blocked')),
  summary text not null check(length(summary) between 8 and 600 and summary !~ '[[:cntrl:]]'),
  next_step text not null default '' check(length(next_step)<=500 and next_step !~ '[[:cntrl:]]'),
  plugin_version text not null check(length(plugin_version) between 1 and 80 and plugin_version !~ '[[:cntrl:]]'),
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  unique(user_id,idempotency_key)
);

create index if not exists idx_codex_plugin_work_updates_daily
  on codex_plugin_work_updates(project_id,user_id,update_date desc,created_at desc,id desc);
create index if not exists idx_codex_plugin_work_updates_owner
  on codex_plugin_work_updates(company_id,user_id,created_at desc,id desc);

commit;
