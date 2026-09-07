create table if not exists tracemini_scan_requests (
  id bigserial primary key, company_id bigint not null references companies(id) on delete cascade,
  user_id bigint not null references app_users(id) on delete cascade, device_id bigint not null references files_agent_devices(id) on delete cascade,
  state text not null default 'queued' check(state in ('queued','running','completed','error')),
  requested_at timestamptz not null default now(), started_at timestamptz, completed_at timestamptz, claimed_at timestamptz, claim_token text check(claim_token is null or claim_token ~ '^[a-f0-9]{32}$'), error text check(error is null or length(error)<=240)
);
create unique index if not exists idx_tracemini_active_scan_device on tracemini_scan_requests(device_id) where state in ('queued','running');
create table if not exists tracemini_repository_candidates (
  id bigserial primary key, scan_id bigint not null references tracemini_scan_requests(id) on delete cascade,
  company_id bigint not null references companies(id) on delete cascade, device_id bigint not null references files_agent_devices(id) on delete cascade,
  display_name text not null check(length(display_name) between 1 and 160), repository_key text not null check(length(repository_key) between 1 and 1024 and repository_key !~ '[[:cntrl:]]'),
  branch text, head_sha text, upstream_head_sha text, remote_branch_sha text, reflog_action text,
  fingerprint jsonb not null default '{}'::jsonb check(jsonb_typeof(fingerprint)='object'),
  match_status text not null default 'unmatched' check(match_status in ('matched','unmatched','ambiguous')),
  matched_project_id bigint references projects(id) on delete set null, tracking_state text not null default 'unselected' check(tracking_state in ('unselected','pending','tracking','stopped')),
  revision bigint not null default 1 check(revision>0), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(device_id,repository_key,fingerprint)
);
create table if not exists tracemini_repository_selections (
  candidate_id bigint primary key references tracemini_repository_candidates(id) on delete cascade, owner_user_id bigint not null references app_users(id), desired_tracking boolean not null,
  revision bigint not null check(revision>0), claimed_at timestamptz, claim_token text check(claim_token is null or claim_token ~ '^[a-f0-9]{32}$'), completed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists tracemini_tracked_repositories (
  candidate_id bigint primary key references tracemini_repository_candidates(id) on delete cascade, project_id bigint not null references projects(id) on delete cascade,
  device_id bigint not null references files_agent_devices(id) on delete cascade, repository_key text not null, fingerprint jsonb not null,
  last_head_sha text, last_remote_head_sha text, history_heads jsonb not null default '[]'::jsonb, hooks_version text not null default '1', updated_at timestamptz not null default now()
);
create table if not exists tracemini_repository_fingerprints (
  candidate_id bigint primary key references tracemini_repository_candidates(id) on delete cascade, device_id bigint not null references files_agent_devices(id) on delete cascade,
  fingerprint jsonb not null check(jsonb_typeof(fingerprint)='object'), observed_at timestamptz not null default now()
);
create table if not exists tracemini_pending_pushes (
  id bigserial primary key, candidate_id bigint not null references tracemini_repository_candidates(id) on delete cascade, expected_head_sha text not null check(expected_head_sha ~ '^[a-f0-9]{40,64}$'),
  branch text not null check(length(branch) between 1 and 200 and branch !~ '[[:cntrl:]]'), status text not null default 'pending' check(status in ('pending','verified','failed')), attempts integer not null default 0 check(attempts>=0), next_check_at timestamptz not null default now(), claim_token text check(claim_token is null or claim_token ~ '^[a-f0-9]{32}$'), verified_at timestamptz, created_at timestamptz not null default now()
);
alter table tracemini_scan_requests add column if not exists repositories_found integer check(repositories_found is null or repositories_found >= 0);
alter table tracemini_scan_requests add column if not exists claimed_at timestamptz;
alter table tracemini_scan_requests add column if not exists claim_token text;
alter table tracemini_repository_selections add column if not exists claim_token text;
alter table tracemini_pending_pushes add column if not exists claim_token text;
create index if not exists idx_tracemini_scans_device_state on tracemini_scan_requests(device_id,state);
create index if not exists idx_tracemini_candidates_company on tracemini_repository_candidates(company_id,created_at desc);
create index if not exists idx_tracemini_pushes_due on tracemini_pending_pushes(status,next_check_at);
create index if not exists idx_tracemini_candidates_device_key on tracemini_repository_candidates(device_id,repository_key);
create index if not exists idx_tracemini_candidates_scan on tracemini_repository_candidates(scan_id,created_at);
