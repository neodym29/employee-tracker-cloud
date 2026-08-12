-- Run each statement separately: CREATE INDEX CONCURRENTLY cannot run in a transaction block.
-- These indexes support company deletion/cleanup FK scans on the large legacy tables.
-- The files-agent tables already have composite indexes whose leading column is company_id.
create index concurrently if not exists idx_activity_events_company_id
  on activity_events (company_id);
create index concurrently if not exists idx_activity_screenshots_company_id
  on activity_screenshots (company_id);
create index concurrently if not exists idx_devices_company_id
  on devices (company_id);
