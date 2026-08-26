-- Stable current file identities plus immutable append-only textual versions.
create table if not exists project_files (
  id bigserial primary key,
  project_id bigint not null references projects(id) on delete cascade,
  file_id text not null check(file_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  version integer not null check(version > 0),
  path text not null check(
    length(path) between 1 and 1024 and path !~ '^/' and path !~ '\\'
    and path !~ '[[:cntrl:]]' and path ~ '^[^/]+(/[^/]+)*$'
    and path !~ '(^|/)\.{1,2}(/|$)'
  ),
  media_type text not null check(length(media_type) between 1 and 255),
  content text not null check(octet_length(content) <= 262144),
  byte_size integer not null check(byte_size >= 0 and byte_size <= 262144 and byte_size = octet_length(content)),
  sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
  created_by bigint not null references app_users(id),
  created_at timestamptz not null default now(),
  unique(project_id,file_id,version)
);

-- Remove the old path/version key on upgraded databases. Historical paths are not identities.
alter table project_files drop constraint if exists project_files_project_id_path_version_key;

create table if not exists project_file_heads (
  project_id bigint not null references projects(id) on delete cascade,
  file_id text not null,
  current_version integer not null check(current_version > 0),
  path text not null check(
    length(path) between 1 and 1024 and path !~ '^/' and path !~ '\\'
    and path !~ '[[:cntrl:]]' and path ~ '^[^/]+(/[^/]+)*$'
    and path !~ '(^|/)\.{1,2}(/|$)'
  ),
  media_type text not null check(length(media_type) between 1 and 255),
  byte_size integer not null check(byte_size >= 0 and byte_size <= 262144),
  sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(project_id,file_id),
  foreign key(project_id,file_id,current_version)
    references project_files(project_id,file_id,version) deferrable initially deferred
);

insert into project_file_heads(project_id,file_id,current_version,path,media_type,byte_size,sha256,deleted_at,updated_at)
select project_id,file_id,version,path,media_type,byte_size,sha256,
       case when media_type='application/x.project-tombstone' then created_at else null end,created_at
from (select distinct on(project_id,file_id) * from project_files order by project_id,file_id,version desc) latest
on conflict(project_id,file_id) do nothing;

create unique index if not exists project_file_heads_active_path_unique
  on project_file_heads(project_id,path) where deleted_at is null;
create index if not exists idx_project_files_latest on project_files(project_id,file_id,version desc);

-- Immutable agent history is retained. Project removal must use an explicit retention workflow.
alter table project_file_heads drop constraint if exists project_file_heads_project_id_fkey;
alter table project_file_heads add constraint project_file_heads_project_id_fkey
  foreign key(project_id) references projects(id) on delete restrict;
alter table project_files drop constraint if exists project_files_project_id_fkey;
alter table project_files add constraint project_files_project_id_fkey
  foreign key(project_id) references projects(id) on delete restrict;
alter table project_agent_actions drop constraint if exists project_agent_actions_project_id_fkey;
alter table project_agent_actions add constraint project_agent_actions_project_id_fkey
  foreign key(project_id) references projects(id) on delete restrict;

create or replace function prevent_project_file_version_mutation() returns trigger language plpgsql as $$
begin raise exception 'project file version rows are immutable'; end $$;
drop trigger if exists prevent_project_file_version_update on project_files;
create trigger prevent_project_file_version_update before update or delete on project_files
  for each row execute function prevent_project_file_version_mutation();

-- New audit rows require an actor, while existing legacy null rows remain readable.
do $$ begin
  if not exists (select 1 from pg_constraint where conname='project_agent_actions_actor_not_null') then
    alter table project_agent_actions add constraint project_agent_actions_actor_not_null
      check(actor_user_id is not null) not valid;
  end if;
end $$;

-- The sole mutation is pending -> terminal with all identity/input/output fields unchanged.
create or replace function prevent_project_agent_action_mutation() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then raise exception 'project agent action audit rows are immutable'; end if;
  if old.status='pending' and new.status in ('confirmed','cancelled')
     and new.id=old.id and new.project_id=old.project_id
     and new.actor_user_id is not distinct from old.actor_user_id
     and new.action_type=old.action_type and new.input=old.input
     and new.output is not distinct from old.output and new.created_at=old.created_at
     and new.confirmed_by=old.actor_user_id and new.confirmed_at is not null
     and new.result is not null then
    return new;
  end if;
  raise exception 'project agent action audit rows are immutable';
end $$;
drop trigger if exists prevent_project_agent_action_update on project_agent_actions;
create trigger prevent_project_agent_action_update before update or delete on project_agent_actions
  for each row execute function prevent_project_agent_action_mutation();
