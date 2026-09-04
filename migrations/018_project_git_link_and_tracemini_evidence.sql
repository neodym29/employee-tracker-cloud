-- Additive Cloud-only schema for Git-linked projects and immutable TraceMini evidence.
alter table projects add column if not exists git_remote_url text;
alter table projects add column if not exists git_repository_key text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='projects_git_link_pair_check') then
    alter table projects add constraint projects_git_link_pair_check check (
      (git_remote_url is null and git_repository_key is null) or
      (git_remote_url is not null and git_repository_key is not null
       and length(git_remote_url) between 1 and 2048
       and length(git_repository_key) between 1 and 1024
       and git_remote_url !~ '[[:cntrl:]]' and git_repository_key !~ '[[:cntrl:]]')
    );
  end if;
end $$;

create table if not exists project_tracemini_repository_matches (
  project_id bigint primary key references projects(id) on delete cascade,
  config_generation bigint not null check(config_generation > 0),
  config_revision bigint not null check(config_revision > 0),
  repository_id text check(repository_id is null or (length(repository_id) between 1 and 200 and repository_id !~ '[[:cntrl:]]')),
  repository_name text check(repository_name is null or (length(repository_name) between 1 and 160 and repository_name !~ '[[:cntrl:]]')),
  repository_key text check(repository_key is null or (length(repository_key) between 1 and 1024 and repository_key !~ '[[:cntrl:]]')),
  match_status text not null check(match_status in ('matched','unmatched','ambiguous')),
  matched_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((match_status='matched' and repository_id is not null and repository_name is not null and repository_key is not null and matched_at is not null)
      or (match_status<>'matched' and repository_id is null and repository_name is null and repository_key is null and matched_at is null))
);
create index if not exists idx_project_tracemini_repository_matches_status on project_tracemini_repository_matches(project_id,match_status);

create table if not exists project_tracemini_evidence (
  project_id bigint not null references projects(id) on delete cascade,
  evidence_key text not null check(evidence_key ~ '^[a-f0-9]{64}$'),
  config_generation bigint not null check(config_generation > 0),
  config_revision bigint not null check(config_revision > 0),
  repository_id text not null check(length(repository_id) between 1 and 200 and repository_id !~ '[[:cntrl:]]'),
  repository_key text not null check(length(repository_key) between 1 and 1024 and repository_key !~ '[[:cntrl:]]'),
  newest_occurred_at timestamptz not null,
  proposed_action_id bigint not null references project_agent_actions(id),
  created_at timestamptz not null default now(),
  constraint project_tracemini_evidence_future_skew_check check(newest_occurred_at <= created_at + interval '5 minutes'),
  primary key(project_id,evidence_key)
);
create index if not exists idx_project_tracemini_evidence_action on project_tracemini_evidence(proposed_action_id);
create index if not exists idx_project_tracemini_evidence_watermark on project_tracemini_evidence(project_id,config_generation,config_revision,repository_id,repository_key,newest_occurred_at desc);

create or replace function prevent_project_tracemini_evidence_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'TraceMini evidence rows are immutable';
end $$;
drop trigger if exists prevent_project_tracemini_evidence_update on project_tracemini_evidence;
create trigger prevent_project_tracemini_evidence_update before update or delete on project_tracemini_evidence
for each row execute function prevent_project_tracemini_evidence_mutation();
