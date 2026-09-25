begin;

alter table codex_plugin_work_updates
  alter column project_id drop not null;

create index if not exists idx_codex_plugin_work_updates_other_daily
  on codex_plugin_work_updates(company_id,user_id,update_date desc,created_at desc,id desc)
  where project_id is null;

commit;
