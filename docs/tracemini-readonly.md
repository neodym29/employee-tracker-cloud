# TraceMini read-only integration deployment

Employee Tracker Cloud can display project-scoped TraceMini Git delivery signals. The integration changes **Employee Tracker Cloud only**; it never migrates or modifies TraceMini data or configuration.

## Deployment

Set these server-only variables on every Cloud instance:

- `TRACEMINI_ENCRYPTION_KEY`: base64 for exactly 32 cryptographically random bytes (for example, generate it with `openssl rand -base64 32`). It is dedicated to TraceMini credentials; the application fails closed and never falls back to `AUTH_SECRET`.
- `TRACEMINI_ALLOWED_ORIGINS`: comma-separated exact trusted TraceMini origins, such as `https://tracemini.example.com`. Values with paths, credentials, queries, or fragments are ignored. HTTPS is required, except loopback HTTP in `NODE_ENV=development`.

Apply both Cloud migrations through the normal migration process, in order:

1. `migrations/017_tracemini_integrations.sql`
2. `migrations/018_project_git_link_and_tracemini_evidence.sql`

Migration 018 is an **expand-only** migration. It adds nullable paired Git-link columns (both null or both set), repository-match state, and proposal-evidence deduplication while continuing to permit legacy writers to insert projects with both Git fields null. Roll it out in this order: apply the expansion everywhere; deploy the new application writers that validate a Git remote and always write both fields; drain old application instances; then verify all newly created projects from the new writers have paired links. Rollback may safely restore an old writer, whose null-linked rows are treated by the new application as attachable legacy projects.

Do not add Git-link `NOT NULL` constraints or an insert trigger to the current/automatic migration chain. Only after old writers are drained and legacy data has been deliberately handled should operators consider a separately reviewed future **contract** migration; no such migration is included in this rollout. Do not run either current migration against the TraceMini database. Back up the encryption key in the deployment secret manager; losing it makes stored sessions undecryptable.

## Exact upstream API contract

The adapter performs only these GET requests, with paths constructed server-side:

- `GET /api/bootstrap`
- `GET /api/workspaces/{workspaceId}/dashboard`
- `GET /api/workspaces/{workspaceId}/settings`
- `GET /api/workspaces/{workspaceId}/agents`
- `GET /api/workspaces/{workspaceId}/reports`

Every request sends the configured TraceMini **user-session** credential in the `Authorization` header using the `Bearer SESSION_TOKEN` scheme. TraceMini does not currently offer a workspace-scoped read-only credential, so possession of that session may carry broader upstream privileges. Use a least-privileged dedicated user where possible.

The dashboard response must be a JSON object containing this envelope before a connection test can succeed or a live refresh can be accepted:

```json
{
  "events": [],
  "repositories": [],
  "stats": {},
  "timeline": []
}
```

All four fields are required with the shown collection/object types. Bootstrap must contain the configured workspace in its `workspaces` array; settings must be an object; agents and reports must be arrays. Responses are size-bounded, timed out, malformed JSON is rejected, and clear transient failures are retried at most once.

## Authorization and browser safety

- One encrypted integration record exists per project and cascades on project deletion.
- User sessions are stored with AES-256-GCM, a random 12-byte IV, a 16-byte authentication tag, a versioned envelope, and project-ID-bound AAD.
- Plaintext sessions and encrypted envelope bytes are never returned by Cloud APIs or rendered in the browser.
- Only the owning client or a strict platform admin (`role=admin` **and** `account_type=admin`) may configure, test, enable, disable, or remove an integration. Active project engineers can read only the normalized project-scoped view.
- Every browser-side mutation is same-origin protected.
- A legacy project with no Git link shows an attach form only to its owner or a strict platform admin. The submitted credential-free remote is parsed and canonicalized; it may be attached exactly once and cannot later be replaced. No project-title or repository-name guessing is used.

## Git matching and privacy

Cloud canonicalizes the project's Git clone remote to a repository key and compares it with canonicalized `normalized_remote` values from the dashboard repository collection. Exactly one match is required. A null key, no exact match, or multiple exact matches fails closed: the public DTO includes only safe match status, empty scoped collections, and zero clone count.

When matched, Cloud returns only the matched repository and events whose `repository_id` is that repository's exact ID. Agent, settings/clone, and report rows are included only when they carry that same exact repository identity. Local clone paths, remote values, machine/device identifiers, credentials, and arbitrary upstream payload fields are never exposed. Clone information is reduced to a boolean and count for the matched repository.

Activity without a valid stable upstream event ID may be displayed with a local UI ID, but it is explicitly ineligible for progress evidence. Events more than five minutes ahead of Cloud's normalization clock may also remain safely visible but are evidence-ineligible, preventing a bad upstream clock from poisoning proposal watermarks. Eligible events are deduplicated by upstream identity and repeated SHA evidence before summaries and evidence digests are produced.

## Owner-confirmed automatic progress proposals

A successful matched refresh may create a bounded automatic `update_project_progress` proposal addressed to the project owner. It never changes authoritative progress directly. Repository identity, integration generation/revision, repository match, and progress version are rechecked transactionally. Evidence watermarks are scoped to the exact project, integration generation/revision, repository ID, and repository key, so removal, reconfiguration, or relinking cannot leave an unrelated historical watermark in control. The owner must review and confirm the pending action through the normal project-action flow; duplicate evidence cannot create an alternate proposal merely because event order, timestamps, or counters changed.

## Operations

Configure the integration in the project workspace and select **Test connection**. Fetch-on-view data is cached in-process for about 30 seconds. A failed refresh may return recent last-good data for a bounded stale window, except for authorization/not-found failures; otherwise only the TraceMini panel becomes unavailable. Safe last-error and last-success timestamps are persisted.

Never place session values in logs, issue trackers, screenshots, or environment examples.
