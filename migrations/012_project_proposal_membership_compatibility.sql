-- Rolling-compatibility bridge after 011.
-- Existing memberships remain ordinary; only the exact new writer marks a proposal row.

alter table projects alter column approval_status set default 'approved';

alter table project_memberships
  add column if not exists is_project_proposal boolean not null default false;

alter table project_memberships drop constraint if exists project_memberships_proposal_shape_check;
alter table project_memberships add constraint project_memberships_proposal_shape_check
  check(not is_project_proposal or (membership_type='request' and created_by=user_id));

create unique index if not exists project_memberships_one_proposal_per_project
  on project_memberships(project_id) where is_project_proposal;
