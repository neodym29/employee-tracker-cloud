-- Intentionally not OWNED BY the integration table: generations survive row/table lifecycle repair,
-- and nextval values are not reused when an insert transaction rolls back.
create sequence if not exists tracemini_integration_generation_seq;

create table if not exists project_tracemini_integrations (
  project_id bigint primary key references projects(id) on delete cascade,
  base_url text not null check(length(base_url) between 1 and 2048),
  workspace_id text not null check(length(workspace_id) between 1 and 200),
  credential_ciphertext bytea not null,
  credential_iv bytea not null check(octet_length(credential_iv)=12),
  credential_tag bytea not null check(octet_length(credential_tag)=16),
  credential_version smallint not null default 1 check(credential_version=1),
  config_generation bigint not null default nextval('tracemini_integration_generation_seq'),
  config_revision bigint not null default 1 check(config_revision>0),
  enabled boolean not null default true,
  last_successful_sync timestamptz,
  last_error text check(last_error is null or length(last_error)<=240),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table project_tracemini_integrations
  add column if not exists config_revision bigint not null default 1;

alter table project_tracemini_integrations
  add column if not exists config_generation bigint default nextval('tracemini_integration_generation_seq');
update project_tracemini_integrations
  set config_generation=nextval('tracemini_integration_generation_seq')
  where config_generation is null;
alter table project_tracemini_integrations
  alter column config_generation set default nextval('tracemini_integration_generation_seq'),
  alter column config_generation set not null;
