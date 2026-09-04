# Embedded TraceMini architecture plan

Date: 2026-09-04
Authoritative source: `/home/jerry/tracemini-upstream` at `7363d85` (read-only).
Provenance/license: capabilities and contracts are adapted from that repository's
`TRACEMINI_SYSTEM_OVERVIEW.md`, `TRACEMINI_IMPLEMENTATION_PLAN.md`, CLI, server, and
web sources. The upstream package is private and declares no license file or SPDX
license; this repo therefore copies behavior/contracts rather than verbatim source
and preserves this attribution for owner/legal review before redistribution.

## Architecture

TraceMini is an embedded capability of Employee Tracker. Employee Tracker sessions,
approved projects, project memberships, and owner/admin authorization are the only
web identity boundary. There is no TraceMini origin, base URL, workspace ID, remote
credential, or runtime call to `tracemini.vercel.app`.

The local files agent remains the only component that can inspect a machine. It sends
file provenance and Git metadata only: repository identity, local root binding,
branch/HEAD, event type/timestamps, bounded counts, and hashes. It never sends file
contents, source, browser/input/screenshot/audio/clipboard data, or arbitrary OS-file
metadata. Git is optional: a Git repository produces Git events and push-confirmation
facts; a non-Git project root and dirty working tree produce explicit uncommitted
provenance events when the approved agent is enrolled for that exact project/root.

Attribution is server-derived from an enrolled agent, authenticated device token,
Employee Tracker user, project, device binding, and an explicitly registered local
root. The agent cannot assert a project ID. For nested roots the server selects the
longest registered root containing the canonical observed path. Absolute roots are
never stored server-side; only a keyed/hash representation and safe display label are
retained. Every accepted event is idempotent and immutable evidence is created only
by owner review/confirmation, never by inferred progress percentage.

## Exact files

Existing files to replace or adapt:

- `lib/tracemini.ts`: embedded dashboard/config/report/evidence service; remove all
  external fetch/configuration flows and preserve safe member redaction.
- `lib/tracemini-adapter.ts`: compatibility-only local adapter alias; no network,
  origin, secret, or baseURL requirement.
- `lib/tracemini-normalize.ts`, `lib/tracemini-confirmation.ts`: retain and extend
  provenance-safe normalization and push confirmation.
- `lib/files-agent.ts`, `lib/files-agent-package.ts`,
  `app/api/files-agent/{enroll,exchange,ingest}/route.ts`, and device routes:
  extend enrollment, hash-only device token exchange, root binding, queue,
  idempotency, revocation, and heartbeat semantics.
- `app/api/projects/[projectId]/tracemini/{route,data/route}.ts`: serve embedded
  project-scoped data and owner-reviewable evidence actions.
- `migrations/017_tracemini_integrations.sql` and
  `migrations/018_project_git_link_and_tracemini_evidence.sql`: keep additive
  compatibility columns/tables for rollback, but add embedded runtime schema and
  correct evidence cascade/delete trigger behavior.

New files:

- `lib/embedded-tracemini.ts`: pure validation, root containment/longest-match,
  event identity, redaction, uncommitted attribution, and report context policies.
- `migrations/019_embedded_tracemini.sql`: additive embedded agents/roots/events,
  report history/schedules, retention/telemetry controls, and evidence ownership.
- `tests/embedded-tracemini.test.mjs`: RED-GREEN security and parity contract tests.

## Parity matrix

| Upstream capability | Embedded status | Boundary |
| --- | --- | --- |
| Git discovery/events | Implemented/adapted | provenance metadata only; Git optional |
| Push confirmation | Implemented/adapted | owner confirmation is sole mutation |
| Dashboard/stats/timeline/date filters | Implemented/adapted | Employee Tracker project routes |
| Personal/workspace Codex/Hermes reports | Implemented server job contract | local agent submits metadata/report output; no source upload; execution remains local |
| Bounded diff consent | Contract implemented | explicit consent and bounded metadata; no automatic diff |
| Local PDF/PPTX context | Slice implemented | local extraction metadata only, bounded and consented |
| Report history/regeneration/schedules | Implemented API/schema and lease-worker slice | local model invocation, PDF/PPTX extraction, Slack delivery, and due-job polling remain |
| Safe member redaction | Implemented | only mapped display identity, no raw email leakage |
| Slack | Env-only opt-in storage contract | timeout/retry/redaction delivery worker remains |
| Enrollment/token mode 0600 | Implemented/adapted | one-use code, hash-only server token, device/root proof, replay-protected signed requests |
| Queue/idempotency/revocation/heartbeat | Implemented/adapted | executable package flushes provenance, explicit heartbeat loop, retries/backoff, project/root/device binding required |

Remaining parity gaps are deliberately recorded here rather than hidden: full
Codex/Hermes process orchestration, PDF/PPTX parser parity, Slack delivery,
complete scheduled-job materialization/claim runner, and complete root/device
management UI still need follow-up vertical slices. The executable package,
lease lifecycle, schedule next-run calculation, replay protection, and the
Docker PostgreSQL evidence gate are implemented in this workspace. No gap
requires an external TraceMini service. This matrix is not a claim of full
upstream parity.

## Additive migration / rollback

Migration 019 is additive and deployable after 017/018. Existing integration rows,
aliases, and evidence keys remain readable for rollback, but new runtime code never
reads their external URL, workspace, or credential. Rollback is: stop embedded
ingest, switch reads to the compatibility data projection, and retain the additive
tables. No destructive backfill or root guessing is allowed. A later cleanup may
remove compatibility columns only after an explicit retention review and a completed
rollback window.

Telemetry pause, wipe, and retention settings are project-owner controlled and default
to paused until an approved agent/root enrollment exists. Wipe removes event/report
payloads while retaining non-sensitive audit facts; cascade deletion removes evidence,
events, roots, jobs, and schedules with the project. Evidence rows cannot be updated
or deleted by application mutation; project deletion uses FK cascade.

## Bite-sized TDD tasks (tests first)

1. RED: reject external origins/baseURL/runtime fetch and prove no upstream hostname;
   GREEN: local adapter alias and embedded service.
2. RED: reject client-asserted project identity and absolute-root persistence;
   GREEN: enrollment/device/root binding and longest-containing-root attribution.
3. RED: accept Git and non-Git dirty evidence only for approved agent/root;
   GREEN: normalized provenance event ingestion.
4. RED: duplicate/revoked/stale-heartbeat events fail safely;
   GREEN: hash-only token, one-use enrollment, idempotency, revocation, heartbeat.
5. RED: prove evidence deletion cascades while evidence mutation is blocked;
   GREEN: additive schema and corrected trigger.
6. RED: no progress percentage is inferred and only owner confirmation mutates;
   GREEN: review action/evidence projection.
7. RED: dashboard filters and member redaction never reveal private inputs/content;
   GREEN: project-scoped timeline/stats/reports projection.
8. RED: bounded diff/document/Slack contracts reject overbroad data/secrets;
   GREEN: consented metadata adapters and env-only Slack configuration.
