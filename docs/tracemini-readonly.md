# Embedded TraceMini operations

TraceMini is embedded in Employee Tracker. It uses Employee Tracker sessions,
approved projects, members, and the existing files-agent enrollment. It has no
runtime origin, base URL, upstream workspace, or stored TraceMini session token.

The agent sends provenance only: Git/non-Git/dirty event type, repository key,
timestamps, branch/HEAD and bounded counts/hashes. It does not send source,
contents, browser/input/screenshot/audio/clipboard data, or OS files. An owner
approves a device/root binding using a root hash and safe label; the absolute root
is local-only. The agent-facing endpoint is `/api/files-agent/tracemini` and derives
the project from the approved `(device, root_hash)` binding. Duplicate events are
idempotent; revoked devices and paused telemetry are rejected.

Use `POST /api/projects/:projectId/tracemini/roots` as the project owner/admin to
approve an enrolled device root. The local agent must choose the longest containing
root before sending its hash. Git is optional, and dirty/non-Git events are valid.

TraceMini data is read-only by default. Existing project actions remain the sole
mutation boundary; no progress percentage is inferred from activity. Evidence is
immutable, but project deletion cascades it. Retention and telemetry pause/wipe are
owner-controlled. Slack configuration, if later enabled, is environment-only.

Apply migrations 017, 018, then additive 019. Existing 017/018 objects remain as
rollback aliases and are not used by the embedded runtime. Rollback can stop
embedded ingest and restore the old projection without destructive cleanup; never
run migrations against an upstream TraceMini database.
