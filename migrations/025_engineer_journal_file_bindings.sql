-- Durable security identity: all versions remain classified, regardless of name/content.
create table if not exists project_engineer_journal_files (
  project_id bigint not null,
  file_id text not null,
  primary key(project_id,file_id),
  foreign key(project_id,file_id) references project_file_heads(project_id,file_id) on delete restrict
);
-- Upgrade legacy projections using immutable history, not the mutable head.
insert into project_engineer_journal_files(project_id,file_id)
select distinct v.project_id,v.file_id from project_files v
join project_file_heads h on h.project_id=v.project_id and h.file_id=v.file_id
where position('<!-- automatic-engineer-journal:start -->' in v.content)>0
on conflict do nothing;
create or replace function prevent_engineer_journal_unbinding() returns trigger language plpgsql as $$
begin raise exception 'Engineer journal binding is immutable'; end $$;
drop trigger if exists prevent_engineer_journal_unbinding on project_engineer_journal_files;
create trigger prevent_engineer_journal_unbinding before update or delete on project_engineer_journal_files
for each row execute function prevent_engineer_journal_unbinding();
