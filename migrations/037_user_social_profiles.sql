create table if not exists user_social_profiles (
  user_id bigint primary key references app_users(id) on delete cascade,
  bio text not null default '' check (length(bio) <= 280),
  status_text text not null default '' check (length(status_text) <= 80),
  avatar_kind text not null default 'initials' check (avatar_kind in ('initials', 'preset', 'photo')),
  avatar_preset text,
  photo_bytes bytea,
  photo_mime text,
  avatar_updated_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
