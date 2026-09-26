alter table app_users add column if not exists email_verified_at timestamptz;
alter table app_users add column if not exists password_changed_at timestamptz;
alter table app_users add column if not exists session_version integer not null default 0;

create table if not exists email_verification_tokens (
  user_id bigint primary key references app_users(id) on delete cascade,
  email text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  sent_at timestamptz not null default now()
);
