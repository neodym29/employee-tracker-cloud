# Applying migration 003 safely

`migrations/003_files_agent_fk_indexes_nontransactional.sql` adds indexes used by company cleanup on the large legacy tables. Do **not** run the file through a migration runner that wraps the file in a transaction: PostgreSQL rejects `CREATE INDEX CONCURRENTLY` in a transaction block.

The files-agent tables need no additional single-column indexes. Their existing composite indexes (`idx_files_agent_devices_company_user` and `idx_files_agent_events_company_received`) already lead with `company_id`.

## Before starting

Use a direct PostgreSQL connection with a role allowed to create indexes. Keep each DDL statement in its own `psql` invocation so it is independently committed. Do not run company cleanup while these indexes are being built.

Set the connection without placing credentials in shell history, for example:

```sh
export DATABASE_URL='postgresql://...'
```

Check for same-named invalid indexes left by an interrupted concurrent build:

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "
SELECT n.nspname AS schema_name, c.relname AS index_name,
       i.indisvalid, i.indisready
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname IN (
  'idx_activity_events_company_id',
  'idx_activity_screenshots_company_id',
  'idx_devices_company_id'
)
ORDER BY c.relname;"
```

If a target index exists with `indisvalid = false`, `IF NOT EXISTS` will not repair it. After confirming its schema, remove only that invalid index in a separate, nontransactional command, then rebuild it below:

```sh
# Example only; schema-qualify and repeat separately for each invalid target.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c 'DROP INDEX CONCURRENTLY IF EXISTS public.idx_activity_events_company_id;'
```

## Build one index at a time

Run these commands individually. Wait for each command to finish successfully before starting the next:

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_events_company_id ON activity_events (company_id);'

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_screenshots_company_id ON activity_screenshots (company_id);'

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_devices_company_id ON devices (company_id);'
```

From a second connection, monitor the active build:

```sh
psql "$DATABASE_URL" -X -c "
SELECT pid, relid::regclass AS table_name, index_relid::regclass AS index_name,
       phase, lockers_total, lockers_done,
       blocks_total, blocks_done, tuples_total, tuples_done
FROM pg_stat_progress_create_index
ORDER BY pid;"
```

An empty result means no build is currently reporting progress; it does not by itself prove success.

## Verify

After all three commands finish, verify that every index is present, ready, valid, and has exactly `company_id` as its indexed key:

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "
SELECT t.relname AS table_name, c.relname AS index_name,
       i.indisready, i.indisvalid,
       pg_get_indexdef(i.indexrelid) AS definition
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_class t ON t.oid = i.indrelid
WHERE c.relname IN (
  'idx_activity_events_company_id',
  'idx_activity_screenshots_company_id',
  'idx_devices_company_id'
)
ORDER BY c.relname;"
```

Expected: three rows, mapped respectively to `activity_events`, `activity_screenshots`, and `devices`; both flags are `true`; each definition ends in `(company_id)`. If a command is interrupted, rerun the invalid-index check and remove/rebuild only the invalid target as described above.
