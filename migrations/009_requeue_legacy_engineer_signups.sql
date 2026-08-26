-- Requeue the exact password-based Engineer signups stranded by the legacy
-- tracker status model. The historical Admin UI had no reject operation, so
-- these unaudited, never-approved rows were not deliberate rejections.
-- ID 2 is intentionally excluded: it is a passwordless telemetry identity
-- with prior approval history.
do $$
declare affected integer;
begin
  update app_users
     set approval_status='pending'
   where id=any(array[3,5,6]::bigint[])
     and account_type='engineer'
     and approval_status='rejected'
     and password_hash is not null
     and approved_at is null
     and reviewed_at is null
     and reviewed_by is null;

  get diagnostics affected = row_count;
  if affected not in (0,3) then
    raise exception 'legacy Engineer requeue expected 0 or 3 exact rows, updated %', affected;
  end if;
end $$;