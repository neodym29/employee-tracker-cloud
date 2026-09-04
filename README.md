# Neodym AI Files Tracker

A Next.js/Postgres portal for company enrollment and **files-only metadata** reporting from approved AI coding-agent process trees.

## Privacy boundary

The active files agent accepts changes attributed only to Hermes, Codex, or Claude wrapper process trees. It reports:

- file path
- action
- timestamp
- device
- approved agent and run identifier

It does **not** collect file contents, screenshots, keyboard or click input, clipboard data, browser activity, audio, terminal commands, windows, or general process activity. The retired legacy ingest, installer, screenshot, and update routes remain as HTTP `410 Gone` tombstones. Historical database tables/data are retained for migration safety but are not queried by active pages.

## Local development

```bash
npm install
npm test
npm run typecheck
npm run build
```

Set `DATABASE_URL` (or `POSTGRES_URL`) and `AUTH_SECRET` for authenticated database-backed use. See `.env.example` and the documentation under `docs/` and `files-agent/`. The optional project-scoped TraceMini integration is documented in [`docs/tracemini-readonly.md`](docs/tracemini-readonly.md).
