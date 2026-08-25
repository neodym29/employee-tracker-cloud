-- Platform accounts, approval, and secure project collaboration foundation.
-- Apply transactionally. Existing telemetry roles/companies remain intact.

alter table app_users add column if not exists display_name text;
alter table app_users add column if not exists account_type text;
alter table app_users add column if not exists reviewed_at timestamptz;
alter table app_users add column if not exists reviewed_by bigint references app_users(id);

update app_users
set account_type = case when role='admin' then 'admin' else 'engineer' end
where account_type is null;
update app_users set display_name=coalesce(nullif(employee_username,''), split_part(email,'@',1)) where display_name is null;
alter table app_users alter column account_type set not null;
alter table app_users alter column display_name set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='app_users_account_type_check') then
    alter table app_users add constraint app_users_account_type_check check(account_type in ('admin','client','engineer'));
  end if;
end $$;

create table if not exists projects (
  id bigserial primary key,
  client_id bigint not null references app_users(id),
  title text not null check(length(title) between 1 and 120),
  description text not null default '' check(length(description) <= 4000),
  status text not null default 'draft' check(status in ('draft','open','active','completed','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists project_memberships (
  id bigserial primary key,
  project_id bigint not null references projects(id) on delete cascade,
  user_id bigint not null references app_users(id),
  membership_type text not null check(membership_type in ('invitation','request')),
  membership_status text not null default 'pending' check(membership_status in ('pending','active','declined','rejected')),
  created_by bigint not null references app_users(id),
  responded_by bigint references app_users(id),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique(project_id,user_id)
);

create table if not exists project_records (
  id bigserial primary key,
  project_id bigint not null references projects(id) on delete cascade,
  record_id text not null,
  version integer not null check(version > 0),
  title text not null check(length(title) between 1 and 160),
  body jsonb not null,
  created_by bigint not null references app_users(id),
  created_at timestamptz not null default now(),
  unique(project_id,record_id,version)
);

create table if not exists project_artifacts (
  id bigserial primary key,
  project_id bigint not null references projects(id) on delete cascade,
  filename text not null check(length(filename) between 1 and 255),
  media_type text not null check(length(media_type) between 1 and 255),
  size_bytes bigint not null check(size_bytes >= 0 and size_bytes <= 1000000000000),
  sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
  storage_key text check(storage_key is null or length(storage_key) <= 1024),
  created_by bigint not null references app_users(id),
  created_at timestamptz not null default now()
);

create table if not exists project_chat_messages (
  id bigserial primary key,
  project_id bigint not null references projects(id) on delete cascade,
  user_id bigint references app_users(id),
  role text not null check(role in ('user','assistant','system')),
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists project_agent_actions (
  id bigserial primary key,
  project_id bigint not null references projects(id) on delete cascade,
  actor_user_id bigint references app_users(id),
  action_type text not null,
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  created_at timestamptz not null default now()
);

create or replace function prevent_project_agent_action_mutation() returns trigger language plpgsql as $$
begin raise exception 'project agent action audit rows are immutable'; end $$;
drop trigger if exists prevent_project_agent_action_update on project_agent_actions;
create trigger prevent_project_agent_action_update before update or delete on project_agent_actions
for each row execute function prevent_project_agent_action_mutation();

create index if not exists idx_app_users_approval_type on app_users (approval_status,account_type,id);
create index if not exists idx_projects_client_status on projects (client_id,status,updated_at desc);
create index if not exists idx_projects_open on projects (updated_at desc,id) where status='open';
create index if not exists idx_project_memberships_user_status on project_memberships (user_id,membership_status,project_id);
create index if not exists idx_project_memberships_project_status on project_memberships (project_id,membership_status,id);
create index if not exists idx_project_records_latest on project_records (project_id,record_id,version desc);
create index if not exists idx_project_artifacts_project on project_artifacts (project_id,created_at desc,id desc);
create index if not exists idx_project_chat_project on project_chat_messages (project_id,created_at,id);
create index if not exists idx_project_agent_actions_project on project_agent_actions (project_id,created_at,id);
