begin;

create table if not exists codex_plugin_connections (
  device_id bigint primary key references files_agent_devices(id) on delete cascade,
  company_id bigint not null references companies(id) on delete cascade,
  user_id bigint not null references app_users(id) on delete cascade,
  plugin_version text constraint codex_plugin_connections_version_length check(plugin_version is null or length(plugin_version) between 1 and 80),
  connected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_poll_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists codex_plugin_connections_owner
  on codex_plugin_connections(company_id,user_id,last_poll_at desc);

commit;
