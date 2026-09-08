-- Explicit association is local-candidate scoped; canonical project remotes are unchanged.
alter table tracemini_repository_candidates add column if not exists explicit_project_id bigint references projects(id);
