# Neodym Employee Tracker Cloud

Vercel-safe cloud prototype for `neodym.ai` employee-device enrollment.

## What this is

- Next.js app deployable to Vercel.
- Admin dashboard for `hello@neodym.ai`.
- Seeded employee record for `ibrahim@neodym.ai`.
- `/api/ingest` endpoint for employee PCs to upload activity.
- Postgres-backed persistence via `DATABASE_URL` or `POSTGRES_URL`.

## Required Vercel env vars for real cross-PC testing

```bash
DATABASE_URL=postgres://...
INGEST_API_KEY=<private shared key or enrollment-token backend>
ADMIN_SETUP_KEY=<private bootstrap key>
NEXT_PUBLIC_APP_URL=https://<project>.vercel.app
```

Without `DATABASE_URL`, the app still deploys and shows readiness/demo screens, but it cannot persist Ibrahim PC activity.

## Bootstrap schema after env vars are set

```bash
curl -X POST https://<project>.vercel.app/api/bootstrap \
  -H "x-admin-setup-key: $ADMIN_SETUP_KEY"
```

## Test ingest

```bash
curl -X POST https://<project>.vercel.app/api/ingest \
  -H "content-type: application/json" \
  -H "x-ingest-key: $INGEST_API_KEY" \
  -d '{
    "employee_email":"ibrahim@neodym.ai",
    "hostname":"ibrahim-pc",
    "os_user":"ibrahim",
    "event_type":"activity_snapshot",
    "app_name":"Chrome",
    "window_title":"Neodym work",
    "captured_at":"'"$(date -Is)"'"
  }'
```
