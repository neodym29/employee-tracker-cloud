-- One-way, audited lifecycle for proposed project agent actions.
alter table project_agent_actions add column if not exists status text not null default 'pending';
alter table project_agent_actions add column if not exists confirmed_by bigint references app_users(id);
alter table project_agent_actions add column if not exists confirmed_at timestamptz;
alter table project_agent_actions add column if not exists result jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='project_agent_actions_status_check') then
    alter table project_agent_actions add constraint project_agent_actions_status_check
      check(status in ('pending','confirmed','cancelled'));
  end if;
end $$;

-- Audit identity/input are immutable. The sole permitted update is pending -> one terminal state.
create or replace function prevent_project_agent_action_mutation() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    raise exception 'project agent action audit rows are immutable';
  end if;
  if old.status='pending' and new.status in ('confirmed','cancelled')
     and new.project_id=old.project_id
     and new.actor_user_id is not distinct from old.actor_user_id
     and new.action_type=old.action_type
     and new.input=old.input
     and new.created_at=old.created_at
     and new.output is not distinct from old.output
     and new.confirmed_by is not null
     and new.confirmed_at is not null then
    return new;
  end if;
  raise exception 'project agent action audit rows are immutable';
end $$;

drop trigger if exists prevent_project_agent_action_update on project_agent_actions;
create trigger prevent_project_agent_action_update before update or delete on project_agent_actions
for each row execute function prevent_project_agent_action_mutation();

create index if not exists idx_project_agent_actions_pending
  on project_agent_actions(project_id,id) where status='pending';
