-- Attributed observer operations are not Git commits and must retain their kind.
alter table project_tracemini_events drop constraint if exists project_tracemini_events_kind_check;
alter table project_tracemini_events add constraint project_tracemini_events_kind_check
 check(kind in ('file_activity','non_git','dirty','commit','branch','merge','rewrite','pull','stage','push','file_change')) not valid;
