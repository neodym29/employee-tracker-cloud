-- Final fail-closed tightening after the explicit project writer is canonical.
-- Rollback ordering: restore default 'approved' before moving the alias to an old writer.

alter table projects alter column approval_status drop default;
