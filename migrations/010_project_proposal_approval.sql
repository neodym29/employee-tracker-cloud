-- Durable project-proposal consent.
-- Additive, transactional, and safe after 007.

alter table projects add column if not exists approval_status text;

-- Grandfather existing projects without fabricating or revoking historical consent.
-- New proposals are written explicitly as pending by the application transaction.
update projects set approval_status='approved' where approval_status is null;

alter table projects alter column approval_status set default 'approved';
alter table projects alter column approval_status set not null;
alter table projects drop constraint if exists projects_approval_status_check;
alter table projects add constraint projects_approval_status_check
  check(approval_status in ('pending','approved','rejected'));

create index if not exists idx_projects_approval_status
  on projects(approval_status,client_id,updated_at desc,id desc);
