begin;

alter table codex_plugin_work_updates
  add column if not exists repository_key text;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname='codex_plugin_work_updates_repository_key_check'
      and conrelid='codex_plugin_work_updates'::regclass
  ) then
    alter table codex_plugin_work_updates
      add constraint codex_plugin_work_updates_repository_key_check
      check(repository_key is null or (
        length(repository_key) between 3 and 1024
        and repository_key !~ '[[:cntrl:]]'
        and repository_key !~ '[@?[:space:]]'
      ));
  end if;
end $$;

create index if not exists idx_codex_plugin_work_updates_unlinked_repository
  on codex_plugin_work_updates(device_id,user_id,repository_key,created_at desc,id desc)
  where project_id is null and repository_key is not null;

commit;
