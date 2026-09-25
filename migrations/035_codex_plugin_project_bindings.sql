begin;

create table if not exists codex_plugin_project_bindings (
  id bigserial primary key,
  device_id bigint not null references files_agent_devices(id) on delete cascade,
  company_id bigint not null references companies(id) on delete cascade,
  user_id bigint not null references app_users(id) on delete cascade,
  project_id bigint not null references projects(id) on delete cascade,
  repository_key text not null check(length(repository_key) between 3 and 2048 and repository_key !~ '[[:cntrl:]]'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(device_id,repository_key)
);

create index if not exists codex_plugin_project_bindings_owner
  on codex_plugin_project_bindings(company_id,user_id,updated_at desc);
create index if not exists codex_plugin_project_bindings_project
  on codex_plugin_project_bindings(project_id,user_id,device_id);

commit;
