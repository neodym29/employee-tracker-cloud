alter table user_social_profiles
  add column if not exists appearance_theme text not null default 'classic',
  add column if not exists appearance_font text not null default 'system';
