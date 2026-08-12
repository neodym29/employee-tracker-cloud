# Files-only daily summary

`GET /api/files-agent/daily-summary` is the scheduled delivery and stored-summary API. Cron builds and durably upserts files-only summaries; authenticated admins read the latest stored delivery (or a stored date). It performs no email or other external side effect.

## Privacy and scope

- Aggregation reads **only** `files_agent_events`, joined to files-agent devices and users while building in memory.
- Every aggregation is tenant-scoped by `company_id` and a half-open `captured_at` interval.
- It never reads legacy activity events, screenshots, clicks, browser, keyboard, clipboard, audio, process, or window telemetry.
- Durable output includes counts by employee/device/action. Telemetry-derived strings are removed before storage.
- Raw paths, filenames, email addresses, device labels, project names, agent-provided strings, and secrets are never persisted in summaries.

## Authorization and reads

- Interactive access: an authenticated admin reads only that admin's tenant. With no date, the latest stored row is returned.
- Scheduler access: set a strong `CRON_SECRET` and send `Authorization: Bearer ***`.
- Cron discovers companies in keyset-paginated pages of 100 and processes tenants sequentially, bounding database load. Every aggregation, upsert, and retention delete remains tenant-scoped. A failed tenant does not prevent later tenants from being delivered.
- Responses use `Cache-Control: no-store, private`.

An optional `date=YYYY-MM-DD` selects a Karachi calendar day. For cron, omission builds the previous completed day in `Asia/Karachi`; for an admin, a supplied date reads that stored date. Bounds use `start <= captured_at < end`.

```sh
curl -H "Authorization: Bearer ***" \
  "https://example.com/api/files-agent/daily-summary?date=2026-08-12"
```

## Durable schedule, migration, and retention

Vercel cron expressions run in UTC. `vercel.json` schedules this endpoint at `20:05 UTC`, or `01:05 Asia/Karachi` the following day, selecting the just-completed Karachi date. Vercel supplies the configured `CRON_SECRET` as the production cron bearer token.

Each version-1 delivery upserts one `files_agent_daily_summaries` row per `(company_id, summary_date)`, so retries are idempotent. Stored JSON includes `schemaVersion: 1` and is fully validated when read. Apply `migrations/004_files_agent_daily_summaries.sql`; an idempotent runtime helper also creates the table/index for rolling upgrades. `migrations/002_files_agent.sql` includes `(company_id, captured_at)` for the aggregation range scan.

Rows older than `FILES_AGENT_SUMMARY_RETENTION_DAYS` are deleted per tenant after delivery. The default is 90 days; accepted values are bounded to 1–3650 days. Aggregation sums the validated payload `count`; zero-count rows represent no actions and are omitted. Setup wipes pause telemetry and coordinate summary upserts/deletes with one PostgreSQL advisory lock; full wipes repeat until telemetry and summary rows are both zero.
