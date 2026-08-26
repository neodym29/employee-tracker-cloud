-- Make proposal decisions compatible with both old and new application writers.
-- A marked proposal membership is the sole membership allowed to transition its project.

create or replace function enforce_project_proposal_membership()
returns trigger
language plpgsql
set search_path=pg_catalog,public
as $$
declare
  proposal_project public.projects%rowtype;
begin
  if tg_op='UPDATE' and new.is_project_proposal is distinct from old.is_project_proposal then
    raise exception 'Project proposal identity is immutable' using errcode='23514';
  end if;

  if not new.is_project_proposal then
    return new;
  end if;

  select * into proposal_project
    from public.projects
   where id=new.project_id
   for update;
  if not found then
    raise exception 'Project proposal has no project' using errcode='23503';
  end if;

  if proposal_project.proposal_kind is distinct from 'engineer_client'
     or proposal_project.creation_requested_by is distinct from new.user_id
     or new.membership_type is distinct from 'request'
     or new.created_by is distinct from new.user_id then
    raise exception 'Project proposal identity is inconsistent' using errcode='23514';
  end if;

  if tg_op='INSERT' then
    if new.membership_status is distinct from 'pending'
       or proposal_project.approval_status is distinct from 'pending'
       or proposal_project.status is distinct from 'draft' then
      raise exception 'New project proposal must be pending and draft' using errcode='23514';
    end if;
    return new;
  end if;

  if new.membership_status is not distinct from old.membership_status then
    return new;
  end if;
  if old.membership_status is distinct from 'pending'
     or new.responded_by is distinct from proposal_project.client_id
     or new.responded_at is null then
    raise exception 'Project proposal decision is invalid' using errcode='23514';
  end if;

  if new.membership_status='active' then
    if proposal_project.approval_status='pending' and proposal_project.status='draft' then
      update public.projects
         set approval_status='approved',status='open',updated_at=now()
       where id=new.project_id;
    elsif proposal_project.approval_status<>'approved'
       or proposal_project.status not in ('open','active','completed') then
      raise exception 'Project proposal approval state is inconsistent' using errcode='23514';
    end if;
  elsif new.membership_status='rejected' then
    if proposal_project.approval_status='pending' and proposal_project.status='draft' then
      update public.projects
         set approval_status='rejected',status='archived',updated_at=now()
       where id=new.project_id;
    elsif proposal_project.approval_status<>'rejected'
       or proposal_project.status<>'archived' then
      raise exception 'Project proposal rejection state is inconsistent' using errcode='23514';
    end if;
  else
    raise exception 'Project proposal decision must approve or reject' using errcode='23514';
  end if;

  return new;
end;
$$;

drop trigger if exists project_proposal_membership_guard on public.project_memberships;
create trigger project_proposal_membership_guard
before insert or update on public.project_memberships
for each row execute function enforce_project_proposal_membership();
