-- Additive only: existing events/reports/documents are not backfilled or rewritten.
create table if not exists project_engineer_journal (
  event_id bigint primary key references project_tracemini_events(id) on delete cascade,
  project_id bigint not null references projects(id) on delete cascade,
  collector_user_id bigint not null references app_users(id),
  root_id bigint,
  occurred_at timestamptz not null,
  ingested_at timestamptz not null,
  summary text not null check(octet_length(summary) between 1 and 4096),
  summary_version integer not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists idx_engineer_journal_project_time on project_engineer_journal(project_id,occurred_at desc,event_id desc);
create index if not exists idx_engineer_journal_collector_time on project_engineer_journal(project_id,collector_user_id,occurred_at desc,event_id desc);
