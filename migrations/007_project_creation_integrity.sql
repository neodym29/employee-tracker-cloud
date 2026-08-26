-- Immediate project formation: explicit creator memberships and durable creation replay.
-- Additive and safe to run transactionally after 005/006.

alter table projects add column if not exists creation_request_key uuid;
alter table projects add column if not exists creation_requested_by bigint references app_users(id);
alter table projects add column if not exists creation_payload_fingerprint text;

alter table projects drop constraint if exists projects_creation_payload_fingerprint_check;
alter table projects add constraint projects_creation_payload_fingerprint_check check(
  creation_payload_fingerprint is null
  or creation_payload_fingerprint ~ '^[a-f0-9]{64}$'
);

do $$
declare constraint_name text;
begin
  for constraint_name in
    select conname from pg_constraint
    where conrelid='project_memberships'::regclass
      and contype='c'
      and pg_get_constraintdef(oid) ilike '%membership_type%'
      and pg_get_constraintdef(oid) not ilike '%creator%'
  loop
    execute format('alter table project_memberships drop constraint %I', constraint_name);
  end loop;
  if not exists (
    select 1 from pg_constraint
    where conrelid='project_memberships'::regclass
      and contype='c'
      and pg_get_constraintdef(oid) ilike '%membership_type%creator%'
  ) then
    alter table project_memberships add constraint project_memberships_membership_type_check
      check(membership_type in ('invitation','request','creator'));
  end if;
end $$;

-- NULL legacy values remain permitted; every new API creation supplies all three columns.
alter table projects drop constraint if exists projects_creation_request_unique;
alter table projects add constraint projects_creation_request_unique
  unique(creation_requested_by,creation_request_key);
