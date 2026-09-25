-- Additive bridge for existing signed cookies. Does not revoke any user/session.
-- Runtime lib/session-revocations.ts initializes the identical minimal table.
create table if not exists auth_session_revocations (
  token_hash text primary key check (length(token_hash) = 64),
  expires_at timestamptz not null,
  revoked_at timestamptz not null default now()
);
-- Optional maintenance may delete rows only after expires_at has passed;
-- do not drop/truncate this table while unexpired cookies exist.
