-- Node Git capability is deliberately separate from Python provenance credentials.
create table if not exists tracemini_node_contexts (
  id bigserial primary key check(id between 1 and 9007199254740991),
  company_id bigint not null references companies(id) on delete cascade,
  user_id bigint not null references app_users(id) on delete cascade,
  unique(company_id,user_id), unique(id,company_id,user_id)
);
create table if not exists tracemini_node_installations (
  id bigserial primary key,
  context_id bigint not null,
  company_id bigint not null,
  user_id bigint not null,
  token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
  scope text not null default 'node-git-install-v1' check(scope='node-git-install-v1'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  foreign key(context_id,company_id,user_id) references tracemini_node_contexts(id,company_id,user_id) on delete cascade
);
create index if not exists tracemini_node_install_rate on tracemini_node_installations(user_id,created_at);
create table if not exists tracemini_node_devices (
  id bigserial primary key check(id between 1 and 9007199254740991),
  context_id bigint not null,
  company_id bigint not null,
  user_id bigint not null,
  installation_hash text not null check(installation_hash ~ '^[a-f0-9]{64}$'),
  credential_hash text not null unique check(credential_hash ~ '^[a-f0-9]{64}$'),
  capability text not null default 'node-git-v1' check(capability='node-git-v1'),
  machine_name text not null check(length(machine_name) between 1 and 80),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '90 days',
  authenticated_at timestamptz,
  revoked_at timestamptz,
  foreign key(context_id,company_id,user_id) references tracemini_node_contexts(id,company_id,user_id) on delete cascade
);
create unique index if not exists tracemini_node_active_installation on tracemini_node_devices(context_id,installation_hash) where revoked_at is null;
