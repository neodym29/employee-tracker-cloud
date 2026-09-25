begin;

alter table codex_plugin_daily_runs add column if not exists summary_version integer;
update codex_plugin_daily_runs set summary_version=1 where summary_version is null;
alter table codex_plugin_daily_runs alter column summary_version set default 2;
alter table codex_plugin_daily_runs alter column summary_version set not null;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname='codex_plugin_daily_summary_version_check'
      and conrelid='codex_plugin_daily_runs'::regclass
  ) then
    alter table codex_plugin_daily_runs add constraint codex_plugin_daily_summary_version_check
      check(summary_version between 1 and 1000);
  end if;
end $$;

commit;
