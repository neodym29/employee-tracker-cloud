-- Actor-private project chat support and bounded shared client priority summaries.
-- No legacy chat is backfilled: ownership and safe summaries cannot be inferred.

create unique index if not exists idx_project_chat_messages_project_id_id_unique
  on project_chat_messages(project_id,id);

create table if not exists project_client_request_summaries (
  id bigserial primary key,
  project_id bigint not null references projects(id) on delete cascade,
  source_message_id bigint not null,
  summary text not null check(length(summary) between 1 and 160 and summary !~ '[[:cntrl:]]'),
  created_at timestamptz not null default now(),
  unique(source_message_id),
  foreign key(project_id,source_message_id)
    references project_chat_messages(project_id,id) on delete cascade
);

alter table project_agent_actions add column if not exists source_message_id bigint;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname='project_agent_actions_source_message_project_fkey'
      and conrelid='project_agent_actions'::regclass
  ) then
    alter table project_agent_actions
      add constraint project_agent_actions_source_message_project_fkey
      foreign key(project_id,source_message_id)
      references project_chat_messages(project_id,id);
  end if;
end $$;

create or replace function validate_project_client_request_summary_source()
returns trigger
language plpgsql
set search_path=pg_catalog,public
as $$
begin
  if not exists (
    select 1
    from public.project_chat_messages m
    join public.projects p on p.id=m.project_id
    where m.project_id=new.project_id
      and m.id=new.source_message_id
      and m.role='user'
      and m.user_id=p.client_id
  ) then
    raise exception 'Client priority source must be the owning client user message in the same project'
      using errcode='23514';
  end if;
  return new;
end $$;

drop trigger if exists validate_project_client_request_summary_source_trigger
  on project_client_request_summaries;
create trigger validate_project_client_request_summary_source_trigger
  before insert or update on project_client_request_summaries
  for each row execute function validate_project_client_request_summary_source();

-- Provenance is part of the immutable pending-action audit record.
create or replace function prevent_project_agent_action_mutation() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then raise exception 'project agent action audit rows are immutable'; end if;
  if old.status='pending' and new.status in ('confirmed','cancelled')
     and new.id=old.id and new.project_id=old.project_id and new.actor_user_id is not distinct from old.actor_user_id
     and new.action_type=old.action_type and new.input=old.input and new.created_at=old.created_at
     and new.display_description is not distinct from old.display_description
     and new.source_message_id is not distinct from old.source_message_id
     and new.output is not distinct from old.output and new.confirmed_by=old.actor_user_id
     and new.confirmed_at is not null and new.result is not null then
    return new;
  end if;
  raise exception 'project agent action audit rows are immutable';
end $$;

create index if not exists idx_project_client_request_summaries_project_created
  on project_client_request_summaries(project_id,created_at desc,id desc);
create index if not exists idx_project_agent_actions_source_message
  on project_agent_actions(project_id,source_message_id)
  where source_message_id is not null;
