-- Shared discovery identity, not a Python credential or a project.
alter table files_agent_devices alter column enrollment_id drop not null;
alter table files_agent_devices add column if not exists node_device_id bigint unique references tracemini_node_devices(id) on delete cascade;
-- credential_hash on a Node identity is random and has no issued bearer secret.
create table if not exists tracemini_node_registrations (
 candidate_id bigint primary key references tracemini_repository_candidates(id) on delete cascade,
 revision bigint not null,
 claim_token text not null,
 created_at timestamptz not null default now()
);
-- Idempotency for the original Node outbox; Python rows retain a NULL key.
alter table tracemini_pending_pushes add column if not exists node_event_key text;
create unique index if not exists tracemini_node_push_event_unique on tracemini_pending_pushes(candidate_id,node_event_key) where node_event_key is not null;
