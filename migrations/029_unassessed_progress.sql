-- Missing assessment is not 30 percent. Migrate only the complete, untouched
-- lifecycle-default fingerprint emitted for open projects by migration 015.
-- A durable provenance row makes every rewrite inspectable and keeps reruns safe.
begin;
alter table projects alter column progress_percent drop not null;
alter table projects alter column progress_percent drop default;
alter table projects alter column progress_summary set default 'Not assessed';

create table if not exists project_progress_migration_audit (
  project_id bigint primary key references projects(id) on delete cascade,
  migration text not null,
  previous_percent integer,
  previous_summary text not null,
  previous_version integer not null,
  previous_progress_updated_at timestamptz not null,
  migrated_at timestamptz not null default now(),
  check(migration='029_unassessed_progress_legacy_open_default')
);

with candidates as (
  select p.id,p.progress_percent,p.progress_summary,p.progress_version,p.progress_updated_at
  from projects p
  where p.status='open'
    and p.progress_percent=30
    and p.progress_summary='Project is open for delivery.'
    and p.progress_version=1
    -- New supported writes use "Not assessed"; this equality is the legacy
    -- creation fingerprint. Later unrelated project updates may change updated_at.
    and p.progress_updated_at=p.created_at
    and not exists (
      select 1 from project_agent_actions a where a.project_id=p.id
        and (a.action_type='update_project_progress'
          or a.result ? 'fromPercent' or a.result ? 'toPercent')
    )
    and not exists (
      select 1 from tracemini_audit_log a where a.project_id=p.id
        and a.action ~* '(progress|assessment|override)'
    )
), recorded as (
  insert into project_progress_migration_audit(
    project_id,migration,previous_percent,previous_summary,previous_version,previous_progress_updated_at
  )
  select id,'029_unassessed_progress_legacy_open_default',progress_percent,
    progress_summary,progress_version,progress_updated_at
  from candidates
  on conflict(project_id) do nothing
  returning project_id
)
update projects p
set progress_percent=null,progress_summary='Not assessed'
from recorded r
where p.id=r.project_id;
commit;
