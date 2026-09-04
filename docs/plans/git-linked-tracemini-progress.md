# Git-linked projects, TraceMini matching, clone visibility, and progress proposals

## Outcome and invariants

Create every project with a credential-free Git remote, use that remote to find the same repository in the configured TraceMini workspace, show safe local-clone availability, and turn new Git evidence into a pending progress proposal. TraceMini remains an immutable, read-only upstream: Cloud sends only authenticated `GET` requests and never changes TraceMini data, settings, repositories, agents, or reports. Git evidence never directly changes `projects.progress_*`; only the project owner can confirm a proposal through the existing confirmation transaction.

The work is limited to `/home/jerry/Desktop/employee-tracker-cloud-tracemini`. Do not change a TraceMini checkout or database.

## Architecture and data flow

1. `ProjectsClient` submits `gitRemote` with the existing idempotency key. `createProject` validates and canonicalizes it before calculating the creation fingerprint, then stores it in the same project/membership transaction. A replay with the same key but a different remote remains a conflict.
2. Cloud stores both a sanitized display remote and a canonical repository key. The key is produced by one pure parser for HTTPS, `ssh://`, and SCP-style Git remotes: reject credentials, query/fragment, control characters, local/file paths, and non-Git HTTP paths; lowercase host, remove the default port, trim leading/trailing `/` and one `.git` suffix from the path, and compare `host/path` exactly. Never use project title or a substring as fallback matching.
3. A configured TraceMini integration uses the encrypted **user session bearer** server-side. The GET-only adapter calls only the deployed endpoints:
   - `GET /api/bootstrap`
   - `GET /api/workspaces/:id/dashboard`
   - `GET /api/workspaces/:id/settings`
   - `GET /api/workspaces/:id/agents`
   - `GET /api/workspaces/:id/reports`
   Every request sets the standard HTTP Authorization header to the Bearer scheme plus the decrypted user-session value, and sets `Accept: application/json`. Remove the invented `/api/workspaces`, `/activity`, and `/repositories` calls. Decode `dashboard.events`, `dashboard.repositories`, `dashboard.stats`, and `dashboard.timeline` from the dashboard response; settings, agents, and reports remain separate responses. Keep origin allowlisting, GET-only path construction, no redirects/cache, timeout, one transient retry, and the one-MiB body limit.
4. Bootstrap verifies the configured workspace ID. Repository candidates come from `dashboard.repositories`; remote values are canonicalized with the same parser as project creation. Exactly one equal canonical key is `matched`. Zero is `unmatched`; more than one is `ambiguous`. Fail closed for malformed envelopes or missing required collections. Never guess and never combine events from unmatched repositories.
5. Settings/agent data may identify local clones, but the browser DTO exposes only aggregate presence (`localCloneCount`, `hasLocalClone`) and safe member/device status for the matched repository. It must omit absolute paths, home names, machine/device IDs, remote URLs, tokens, and arbitrary settings. The project remote is displayed from Cloud's sanitized project value, not echoed from TraceMini.
6. After a successful matched refresh, a server-side proposal service consumes only allowlisted, matched-repository Git evidence. It creates at most one pending `update_project_progress` action per evidence snapshot, addressed to the project's owning client. The proposal appears in the existing review queue and uses the existing owner-confirm/cancel routes. Confirmation reauthorizes the owner, checks `expectedVersion`, locks the project/action, updates progress, and writes the audit receipt; cancellation leaves progress untouched.

## Persistence contract

Add `migrations/018_project_git_link_and_tracemini_evidence.sql`, mirrored in runtime bootstrap in `lib/db.ts`:

- Add nullable `projects.git_remote_url text` and `projects.git_repository_key text` with a paired-null check plus bounded/control-character checks. Migration 018 is expand-only: existing rows remain null and old application writers may continue inserting paired nulls during a rolling deployment. New application writers strictly require and persist both fields. Apply expansion first, deploy new writers, drain old writers, and verify new rows before even considering a separately reviewed future contract migration; no trigger, `NOT NULL`, or automatic migration 019 is included here. The application must label authorized legacy projects `Git link missing` and allow the owner to attach one once; it must not title-match them.
- Add `project_tracemini_repository_matches(project_id PK/FK on delete cascade, config_generation, config_revision, repository_id, repository_name, repository_key, match_status check in ('matched','unmatched','ambiguous'), matched_at, updated_at)`. Store no upstream remote URL or clone path. Replace this row on each successful current-generation refresh; discard stale-generation results.
- Add `project_tracemini_evidence(project_id, evidence_key, config_generation, config_revision, repository_id, repository_key, newest_occurred_at, proposed_action_id FK project_agent_actions, created_at, primary key(project_id,evidence_key))`. `evidence_key` is SHA-256 over the project ID, integration generation/revision, matched repository ID, sorted allowlisted event IDs/types/SHAs, and current progress version. Watermarks use the same exact configuration/repository scope. Persist only this digest plus bounded identifiers/timestamp, not raw upstream JSON, and reject timestamps beyond the fixed five-minute future-skew allowance.
- Add indexes for `(project_id, match_status)` and `proposed_action_id`. Add an immutability trigger for evidence rows. Extend the existing `project_agent_actions` immutability tests only if the implementation adds source metadata there; prefer the separate evidence table.
- The proposal/evidence insert is one database transaction: take a project-scoped advisory transaction lock, lock the approved project, recheck the integration generation/revision and repository match, return when the evidence key already exists or an owner proposal is pending, insert the pending action, then insert its immutable evidence row with `proposed_action_id` populated. Roll back both on any conflict/failure; never update the evidence row after insertion.

## Exact proposal policy

Implement the pure policy in new `lib/tracemini-progress.ts`:

- Inputs: current `{percent, summary, version}`, matched repository ID, and normalized new events since the last evidence timestamp. Accept only events carrying a stable event ID, valid timestamp, exact matched repository identity, an allowlisted Git type (`clone`, `checkout`, `commit`, `push`, including their deployed namespaced equivalents), and safe counts/hex SHAs. Ignore rejected/unconfirmed operations and arbitrary messages.
- No qualifying new events means no proposal. Never decrease progress and never propose `100%` from Git evidence alone.
- Deterministic candidate floors are: clone/checkout `20`, commit `50`, and confirmed/successful push `75`. The proposed percent is `max(current.percent, highest observed floor)`. If that equals the current percent, still propose only when the bounded factual summary differs; otherwise do nothing.
- The summary is generated by Cloud, not copied from upstream: `TraceMini observed <N> new Git event(s) for <safe repository name>; latest was <type> at <UTC timestamp>.` It is control-character-free and at most 240 characters.
- Create the action with `actor_user_id=projects.client_id`, `action_type='update_project_progress'`, input `{percent, summary, expectedVersion}`, and an immutable display description containing current/proposed percent and the factual summary. This intentionally makes the owner the sole reviewer under the existing confirmation authorization. Engineers can see project-safe evidence/clone status but cannot confirm an automatic proposal.
- New evidence arriving while an owner proposal is pending creates no second proposal. After confirm/cancel, the next refresh may propose from only evidence newer than the claimed watermark. A version conflict leaves the proposal pending/error-safe for owner refresh; it never applies against a changed project version.

## TDD implementation sequence

### 1. Lock the remote parser and project-creation contract

Create `tests/project-git-link.test.mjs` first, with table-driven tests for equivalent HTTPS/SSH/SCP remotes, `.git` handling, case/default ports, and rejection of credentials, local/file/absolute/traversal paths, query/fragment, controls, empty owner/repository paths, and secret-shaped inputs. Test that `gitRemote` participates in `creationFingerprint`, SQL persistence, and idempotent replay conflict behavior for both client- and engineer-created projects.

Then:

- Add pure `parseGitRemote`/`canonicalRepositoryKey` functions in new `lib/git-remote.ts`.
- Extend the input type, validation, fingerprint, insert/return/list queries in `lib/projects.ts`.
- Extend `POST /api/projects` contract through existing `app/api/projects/route.ts` without weakening same-origin/session checks.
- Add required Git remote fields and idempotency fingerprint state in `app/projects/ProjectsClient.tsx`; show inline validation and the sanitized remote on project cards/workspace.
- Add migration/runtime schema changes in `migrations/018_project_git_link_and_tracemini_evidence.sql` and `lib/db.ts`.

### 2. Correct and contract-test the deployed TraceMini adapter

Update `tests/tracemini-readonly.test.mjs` first with fetch spies asserting the five exact paths above, GET-only requests, and the user-session bearer header. Add sanitized fixtures for bootstrap, dashboard (including `events`, `repositories`, `stats`, `timeline`), settings, agents, and reports. Add negative fixtures for malformed/missing collections, oversized bodies, workspace mismatch, redirects, unauthorized responses, timeout, and config-generation races. Explicitly assert the old `/api/workspaces`, `/activity`, and `/repositories` paths are absent.

Then:

- Replace `ENDPOINTS` and endpoint typing in `lib/tracemini-adapter.ts` with `bootstrap`, `dashboard`, `settings`, `agents`, and `reports`.
- Replace `UpstreamData`/`fetchUpstream` in `lib/tracemini.ts`: call bootstrap for connection verification; fetch dashboard/settings/agents/reports for data; derive events/repositories/stats/timeline from dashboard. Rename `credential` variables/UI copy to `userSession` where practical while retaining the encrypted envelope columns for migration compatibility.
- Update `lib/tracemini-normalize.ts` to accept the corrected envelopes and preserve only allowlisted fields.
- Update `docs/tracemini-readonly.md` with the exact endpoints and accepted broad user-session-token limitation.

### 3. Match repositories and expose safe clone availability

Extend `tests/tracemini-readonly.test.mjs` (or create focused `tests/tracemini-repository-match.test.mjs`) before service code. Cover exact canonical match, zero/duplicate match, changed integration generation, repository rename/remote change, unrelated-repository event exclusion, multiple users/clones, and settings containing hostile paths/remotes/device IDs/secrets. Assert the public DTO contains `matchStatus`, safe matched name, `hasLocalClone`, and `localCloneCount`, but serialized output contains none of those sensitive source values.

Then:

- Add matching/clone DTO functions to `lib/tracemini-normalize.ts` using `lib/git-remote.ts`.
- In `lib/tracemini.ts`, load the project's repository key under existing approved-owner/active-member authorization, persist only a current-generation match row, scope all normalized events/clone aggregates to the single match, and preserve cache generation checks.
- Extend `app/api/projects/[projectId]/tracemini/data/route.ts` response through the service only; do not expose raw upstream payloads.
- Update TraceMini types/rendering in `app/projects/[projectId]/WorkspaceClient.tsx` to show `Matched`, `No match`, or `Ambiguous`, the Cloud-owned Git remote, and `Local clone available`/count without a filesystem path. Keep stale/unavailable states isolated from the rest of the workspace.

### 4. Generate reviewable automatic progress proposals

Create `tests/tracemini-progress-proposals.test.mjs` first. Unit-test the exact floors/summary policy, ignored rejected/unconfirmed/unmatched evidence, no decrease/no automatic 100, deduplication under concurrent refresh, one-pending-proposal behavior, evidence watermarking, owner assignment, and hostile text redaction. Service tests must prove a refresh never executes `UPDATE projects SET progress_*`, while owner confirmation does so only through `confirmProjectAgentAction`; engineer/unrelated confirmation is denied, cancellation is non-mutating, and expected-version conflicts fail closed.

Then:

- Implement normalization/policy/digest in new `lib/tracemini-progress.ts`.
- Add `proposeTraceMiniProgress` orchestration in `lib/tracemini.ts` (or a new `lib/tracemini-progress-service.ts` if needed to avoid a dependency cycle). Invoke it after a fresh, current-generation, uniquely matched fetch; proposal failure must not make read-only TraceMini display unavailable.
- Reuse the pending action DTO and confirmation/cancel routes in `lib/project-chat.ts`, `lib/project-chat-dto.ts`, and `app/api/projects/[projectId]/agent-actions/[actionId]/{confirm,cancel}/route.ts`. Add a narrowly scoped service entry point for system-created pending actions rather than routing evidence through the LLM/chat parser.
- In `app/projects/[projectId]/WorkspaceClient.tsx`, label these actions `Automatic progress proposal`, show the safe evidence summary/current-to-proposed percentage, and retain explicit Confirm/Cancel buttons. Refresh overview, actions, and TraceMini after either decision.

### 5. Regression, security, and deployment verification

Run in order:

1. `node --test tests/project-git-link.test.mjs tests/tracemini-repository-match.test.mjs tests/tracemini-progress-proposals.test.mjs`
2. `node --test tests/tracemini-readonly.test.mjs tests/project-progress-actions.test.mjs tests/projects-security-foundation.test.mjs tests/engineer-project-creation.test.mjs`
3. `npm test`
4. `npm run typecheck`
5. `npm run build`

Before release, apply expand-only migration 018 to Cloud first, configure `TRACEMINI_ALLOWED_ORIGINS` and `TRACEMINI_ENCRYPTION_KEY`, deploy the new writers, drain old writers, and verify paired links on new-writer rows. Test with a dedicated least-privileged TraceMini user session. Verify network logs show only the five GET routes, no bearer/path/remote secrets are logged, an unmatched repository creates no proposal, a matched refresh creates exactly one pending owner proposal, progress remains unchanged before confirmation, and confirmation updates progress/audit once. Rollback disables proposal generation first and may restore legacy writers that create paired-null, attachable rows; schema additions may remain because they are additive. A future contract-enforcement migration requires a separate review and is not part of the automatic/current chain. Never run a Cloud migration against TraceMini.

## Definition of done

- New projects cannot be created without a valid credential-free Git remote; legacy projects are explicit and never guessed.
- A project links to TraceMini only on one exact canonical repository match in its configured workspace.
- Members can see safe clone availability but no local path, raw remote, device ID, bearer, or settings payload.
- The adapter uses only the confirmed deployed GET endpoints with an encrypted-at-rest user session bearer.
- Git evidence produces deduplicated pending owner proposals; it cannot directly mutate authoritative progress or produce 100% completion.
- Existing authorization, immutable action audit, stale-cache safety, and TraceMini read-only constraints remain covered by tests.