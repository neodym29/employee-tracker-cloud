create table if not exists project_tracemini_original_summaries (
  report_id bigint primary key references project_tracemini_reports(id),
  project_id bigint not null references projects(id),
  collector_user_id bigint not null references app_users(id),
  root_id bigint, device_id bigint,
  start_date date not null,end_date date not null,source_created_at timestamptz not null,
  markdown text not null check(octet_length(markdown) between 1 and 64000),
  saved_at timestamptz not null default now()
);
create index if not exists idx_tracemini_original_scope on project_tracemini_original_summaries(project_id,collector_user_id,end_date desc,report_id desc);
