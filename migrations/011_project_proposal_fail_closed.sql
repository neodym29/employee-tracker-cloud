-- Fail-closed proposal state and durable proposal identity.
-- Additive and transactional after 010. Existing rows are not reclassified.

alter table projects add column if not exists proposal_kind text;
alter table projects alter column approval_status drop default;

alter table projects drop constraint if exists projects_proposal_kind_check;
alter table projects add constraint projects_proposal_kind_check
  check(proposal_kind is null or proposal_kind='engineer_client');

alter table projects drop constraint if exists projects_pending_proposal_state_check;
alter table projects add constraint projects_pending_proposal_state_check
  check(coalesce(proposal_kind='engineer_client' and approval_status='pending' and status='draft',false)
    or approval_status<>'pending');

alter table projects drop constraint if exists projects_rejected_proposal_state_check;
alter table projects add constraint projects_rejected_proposal_state_check
  check(coalesce(proposal_kind='engineer_client' and approval_status='rejected' and status='archived',false)
    or approval_status<>'rejected');

alter table projects drop constraint if exists projects_proposal_actor_check;
alter table projects add constraint projects_proposal_actor_check
  check(proposal_kind is null or creation_requested_by is not null);
