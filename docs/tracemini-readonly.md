# TraceMini read-only integration deployment

Employee Tracker Cloud can show project-scoped TraceMini Git activity. This integration changes **Employee Tracker Cloud only**. It does not migrate or modify TraceMini data or configuration.

## Configuration

Set these server-only environment variables on every Cloud instance:

- `TRACEMINI_ENCRYPTION_KEY`: base64 for exactly 32 cryptographically random bytes. Generate outside source control (for example, `openssl rand -base64 32`). This key is dedicated to TraceMini credentials; the application fails closed and never falls back to `AUTH_SECRET`.
- `TRACEMINI_ALLOWED_ORIGINS`: comma-separated exact trusted TraceMini origins, such as `https://tracemini.example.com`. Values with paths, credentials, query strings, or fragments are ignored. HTTPS is mandatory; loopback HTTP is accepted only when `NODE_ENV=development`.

Apply `migrations/017_tracemini_integrations.sql` through the normal Cloud migration process before release. Runtime schema initialization also creates the table for existing deployment conventions. Back up `TRACEMINI_ENCRYPTION_KEY` in the deployment secret manager: losing it makes stored credentials undecryptable. Rotation requires re-entering project tokens unless a separate re-encryption procedure is implemented.

## Security and authorization

- One integration record exists per project and is removed with that project.
- Session tokens are stored using AES-256-GCM with a random 12-byte IV, 16-byte authentication tag, a versioned envelope, and project-ID-bound AAD.
- Tokens and encrypted envelope bytes are never returned by Cloud APIs or rendered in the browser.
- Only the owning client or a strict platform admin (`role=admin` and `account_type=admin`) can configure, test, enable, disable, or remove an integration. Active project members may read normalized data.
- Every browser-side change requires same-origin validation.
- The server adapter exports GET only, constructs endpoint paths itself, times out, bounds response bytes, rejects malformed JSON, and retries at most once for clear transient failures.

## Accepted upstream-token limitation

TraceMini currently has no workspace-scoped read-only credential. Its API requires a broader **user session token**. The Cloud adapter remains GET-only and uses only workspace-list/dashboard/activity/repositories/agents/reports reads, but possession of the upstream token carries the user's broader TraceMini privileges. This limitation is explicitly accepted for this integration. Use a least-privileged dedicated TraceMini user when operationally possible, restrict allowed origins, and protect the Cloud encryption key.

## Operations

Configure an integration from the project workspace, save it, then use **Test connection**. The test verifies that `/api/workspaces` returns the configured workspace and that its dashboard is readable. Fetch-on-view data is cached in-process for about 30 seconds. A failed refresh returns stale last-good data where available; otherwise the TraceMini panel becomes unavailable without breaking the rest of the project page. Safe last error and last successful refresh timestamps are persisted for operators.

Do not put token values in logs, issue trackers, screenshots, or environment examples. Do not run this migration against TraceMini's database.
