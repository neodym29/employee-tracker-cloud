-- Durable project delivery progress, independent from project lifecycle status.
-- Apply transactionally. Existing rows are backfilled from the former status display mapping.

alter table projects add column if not exists progress_percent integer;
alter table projects add column if not exists progress_summary text;
alter table projects add column if not exists progress_version integer;
alter table projects add column if not exists progress_updated_at timestamptz;
alter table project_agent_actions add column if not exists display_description text;

-- Reapplying this migration also tightens the existing audit trigger without
-- rewriting legacy rows: null display snapshots compare safely and immutably.
create or replace function prevent_project_agent_action_mutation() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then raise exception 'project agent action audit rows are immutable'; end if;
  if old.status='pending' and new.status in ('confirmed','cancelled')
     and new.id=old.id and new.project_id=old.project_id and new.actor_user_id is not distinct from old.actor_user_id
     and new.action_type=old.action_type and new.input=old.input and new.created_at=old.created_at
     and new.display_description is not distinct from old.display_description
     and new.output is not distinct from old.output and new.confirmed_by=old.actor_user_id
     and new.confirmed_at is not null and new.result is not null then
    return new;
  end if;
  raise exception 'project agent action audit rows are immutable';
end $$;

update projects
set progress_percent=case status
      when 'draft' then 10
      when 'open' then 30
      when 'active' then 65
      when 'completed' then 100
      else 0
    end,
    progress_summary=case status
      when 'draft' then 'Project is in draft.'
      when 'open' then 'Project is open for delivery.'
      when 'active' then 'Project delivery is active.'
      when 'completed' then 'Project delivery is complete.'
      else 'Project is archived.'
    end,
    progress_version=1,
    progress_updated_at=coalesce(updated_at,created_at,now())
where progress_percent is null or progress_summary is null or progress_version is null or progress_updated_at is null;

alter table projects alter column progress_percent set default 10;
alter table projects alter column progress_summary set default 'Project is in draft.';
alter table projects alter column progress_version set default 1;
alter table projects alter column progress_updated_at set default now();
alter table projects alter column progress_percent set not null;
alter table projects alter column progress_summary set not null;
alter table projects alter column progress_version set not null;
alter table projects alter column progress_updated_at set not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='projects_progress_percent_check' and conrelid='projects'::regclass) then
    alter table projects add constraint projects_progress_percent_check check(progress_percent between 0 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname='projects_progress_summary_check' and conrelid='projects'::regclass) then
    alter table projects add constraint projects_progress_summary_check check(length(progress_summary) between 1 and 240 and progress_summary !~ '[[:cntrl:]]');
  end if;
  if not exists (select 1 from pg_constraint where conname='projects_progress_version_check' and conrelid='projects'::regclass) then
    alter table projects add constraint projects_progress_version_check check(progress_version > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='project_agent_actions_display_description_check' and conrelid='project_agent_actions'::regclass) then
    alter table project_agent_actions add constraint project_agent_actions_display_description_check
      check(display_description is null or (length(display_description) between 1 and 320 and display_description !~ '[[:cntrl:]]'));
  end if;
end $$;
