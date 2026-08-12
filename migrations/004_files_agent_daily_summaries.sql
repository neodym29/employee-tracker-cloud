begin;

create table if not exists files_agent_daily_summaries (
  id bigserial primary key,
  company_id bigint not null references companies(id) on delete cascade,
  summary_date date not null,
  timezone text not null default 'Asia/Karachi',
  summary jsonb not null check(jsonb_typeof(summary)='object'),
  generated_at timestamptz not null default now(),
  unique(company_id,summary_date)
);

create index if not exists idx_files_agent_daily_summaries_company_date
  on files_agent_daily_summaries(company_id,summary_date desc);

commit;
