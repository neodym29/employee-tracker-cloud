import 'server-only';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { ensureSchema, getPool } from './db';
import { type SessionUser } from './auth';
import { ProjectServiceError } from './projects';

const MAX_REPOSITORIES = 500;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_FINGERPRINT_KEYS = new Set(['device_id', 'device', 'inode', 'birthtime_ns', 'birthtime', 'git_device', 'git_inode']);
const SHA = /^[a-f0-9]{40,64}$/i;

function invalid(message: string): never { throw new ProjectServiceError(message, 400, 'invalid_request'); }
function numericId(value: unknown, name = 'identifier'): string {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) invalid(`${name} is invalid`);
  return text;
}
function text(value: unknown, name: string, max: number, required = false): string | null {
  if (typeof value !== 'string') { if (required) invalid(`${name} is required`); return null; }
  if (!value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${name} is invalid`);
  return value;
}
function canonicalKey(value: unknown): string {
  const key = text(value, 'repository_key', 1024, true)!;
  const localKey = /^local:[a-f0-9]{64}$/i.test(key);
  const hostedKey = /^[a-z0-9][a-z0-9._/-]*$/.test(key);
  if ((!localKey && !hostedKey) || /[@?\s]/.test(key)) invalid('repository_key must be a credential-free canonical key');
  return key;
}
function sha(value: unknown, name: string, required = false): string | null {
  const valueText = text(value, name, 80, required);
  if (valueText && !SHA.test(valueText)) invalid(`${name} is invalid`);
  return valueText;
}
function pushRef(value: unknown): string {
  const ref = text(value, 'branch', 200, true)!;
  if (!/^refs\/(heads|tags)\/.+/.test(ref) || /[\s~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.includes('@{') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.') || ref.split('/').some(p => p.startsWith('.') || p.endsWith('.lock'))) invalid('push requires an exact destination ref');
  return ref;
}
function fingerprint(value: unknown): Record<string, string | number> {
  // Original Node CLI hashes Git directory dev/inode/birthtime. No local paths.
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && 'digest' in value) {
    const digest = (value as {digest:unknown}).digest;
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) invalid('fingerprint.digest is invalid');
    return {digest};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('fingerprint must be an object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !MAX_FINGERPRINT_KEYS.has(key))) invalid('fingerprint contains unsupported fields');
  const result: Record<string, string | number> = {};
  const deviceValue = input.device_id ?? input.device;
  if (deviceValue !== undefined) result.device_id = typeof deviceValue === 'string' ? text(deviceValue, 'device_id', 160, true)! : (typeof deviceValue === 'number' && Number.isSafeInteger(deviceValue) && deviceValue >= 0 ? deviceValue : invalid('fingerprint.device_id is invalid'));
  for (const [source, target] of [['inode', 'inode'], ['birthtime_ns', 'birthtime_ns'], ['birthtime', 'birthtime_ns'], ['git_device', 'git_device'], ['git_inode', 'git_inode']] as const) {
    if (input[source] === undefined) continue;
    if (typeof input[source] === 'number' && Number.isSafeInteger(input[source]) && input[source] >= 0) result[target] = input[source];
    else invalid(`fingerprint.${source} is invalid`);
  }
  if (!Object.keys(result).length) invalid('fingerprint must identify the local device');
  return result;
}
function credentialHash(credential: string): string { return crypto.createHash('sha256').update(credential, 'utf8').digest('hex'); }
let bindingSchema: Promise<unknown> | undefined;
async function db(): Promise<ReturnType<typeof getPool>> { await ensureSchema(); await (bindingSchema ??= getPool().query(fs.readFileSync(path.join(process.cwd(),'migrations/023_tracemini_candidate_project_binding.sql'),'utf8')).catch(e=>{bindingSchema=undefined;throw e;})); return getPool(); }
async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await (await db()).connect();
  try { await client.query('begin'); const result = await fn(client); await client.query('commit'); return result; }
  catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}
export type DiscoveryCredential = string | {nodeToken: string};
export async function deviceForCredential(client: PoolClient, credential: DiscoveryCredential) {
  if (typeof credential !== 'string') {
    if (!/^etn_[A-Za-z0-9_-]{43}$/.test(credential.nodeToken)) throw new ProjectServiceError('Invalid Node credential',401,'unauthorized');
    const result = await client.query(`select d.id,d.company_id,d.user_id,n.context_id from files_agent_devices d
      join tracemini_node_devices n on n.id=d.node_device_id and n.company_id=d.company_id and n.user_id=d.user_id
      join app_users u on u.id=d.user_id and u.company_id=d.company_id
      where n.credential_hash=$1 and n.capability='node-git-v1' and n.revoked_at is null and n.expires_at>now()
      and d.revoked_at is null and u.approval_status='approved' for update of d,n`,[credentialHash(credential.nodeToken)]);
    if (!result.rows[0]) throw new ProjectServiceError('Invalid Node credential',401,'unauthorized');
    return result.rows[0] as {id:string;company_id:string;user_id:string;context_id?:string};
  }
  if (!credential || credential.length > 512) throw new ProjectServiceError('Invalid device credential', 401, 'unauthorized');
  const result = await client.query(`select d.id,d.company_id,d.user_id from files_agent_devices d join app_users u on u.id=d.user_id and u.company_id=d.company_id and u.approval_status='approved' where d.credential_hash=$1 and d.revoked_at is null for update of d`, [credentialHash(credential)]);
  if (!result.rows[0]) throw new ProjectServiceError('Invalid device credential', 401, 'unauthorized');
  return result.rows[0] as { id: string; company_id: string; user_id: string; context_id?: string };
}
async function ownedDevice(client: PoolClient, session: SessionUser, deviceId: unknown) {
  const result = await client.query(`select d.id from files_agent_devices d join app_users u on u.id=d.user_id and u.company_id=d.company_id and u.approval_status='approved'
    where d.id=$1 and d.company_id=$2 and d.user_id=$3 and d.revoked_at is null for update of d`, [numericId(deviceId, 'device_id'), session.company_id, session.id]);
  if (!result.rows[0]) throw new ProjectServiceError('Active device not found', 404, 'not_found');
  return result.rows[0].id as string;
}
function iso(value: unknown): string | null { return value ? new Date(value as string).toISOString() : null; }

// Projects have no company_id: tenant scope derives from the project owner.
// Retain owner-or-active-member authority, never a cached match.
async function authorizedMatch(client: PoolClient, company: string, user: string, key: string, candidate?: string): Promise<string | null> {
  const result = await client.query(`select p.id from projects p join app_users owner on owner.id=p.client_id
    where owner.company_id=$1 and p.approval_status='approved' and (case when (select explicit_project_id from tracemini_repository_candidates where id=$4) is not null then p.id=(select explicit_project_id from tracemini_repository_candidates where id=$4) else p.git_repository_key=$3 end)
    and exists(select 1 from app_users u where u.id=$2 and u.company_id=$1 and u.approval_status='approved')
    and (p.client_id=$2 or exists(select 1 from project_memberships m where m.project_id=p.id and m.user_id=$2 and m.membership_status='active'))`, [company,user,key,candidate??null]);
  return result.rows.length === 1 ? String(result.rows[0].id) : null;
}

function discoveryRootHash(candidateId: string): string {
  return credentialHash(`tracemini-discovery-candidate:${candidateId}`);
}

async function deviceBinding(client: PoolClient, device: {id:string;user_id:string}, candidate: string, project: string, key: string) {
  const signingKey = process.env.FILES_AGENT_BINDING_KEY || process.env.SESSION_SECRET;
  if (!signingKey || Buffer.byteLength(signingKey) < 32) throw new ProjectServiceError('Binding service unavailable',503,'unavailable');
  const rootHash = discoveryRootHash(candidate);
  const existing = await client.query(`select binding_id,status,revoked_at from project_tracemini_roots where project_id=$1 and device_id=$2 and root_hash=$3 for update`, [project,device.id,rootHash]);
  const prior = existing.rows[0];
  const bindingId = prior?.status === 'approved' && !prior.revoked_at && prior.binding_id ? prior.binding_id : crypto.randomBytes(32).toString('base64url');
  const secret = crypto.createHmac('sha256',signingKey).update(`${bindingId}\0${device.id}\0${project}`).digest('base64url');
  await client.query(`insert into project_tracemini_roots(project_id,device_id,binding_id,binding_secret_hash,root_hash,root_label,repository_key,status,approved_by,approved_at,last_heartbeat_at)
    values($1,$2,$3,$4,$5,'discovered-repository',$6,'approved',$7,now(),now())
    on conflict(project_id,device_id,root_hash) do update set binding_id=excluded.binding_id,binding_secret_hash=excluded.binding_secret_hash,status='approved',revoked_at=null,last_heartbeat_at=now()`,
    [project,device.id,bindingId,credentialHash(secret),rootHash,key,device.user_id]);
  return {binding_id:bindingId,binding_secret:secret,root_hash:rootHash};
}

export async function createRepositoryScan(session: SessionUser, deviceId: unknown) {
  return transaction(async (client) => {
    const owned = await ownedDevice(client,session,deviceId);
    const result = await client.query(`insert into tracemini_scan_requests(company_id,user_id,device_id) values($1,$2,$3)
      on conflict(device_id) where state in ('queued','running') do update set requested_at=now() returning id,state,requested_at`, [session.company_id, session.id, owned]);
    const row = result.rows[0];
    return { requestId: String(row.id), state: row.state, requestedAt: new Date(row.requested_at).toISOString() };
  });
}

export async function repositoryScanStatus(session: SessionUser, requestValue: unknown) {
  const requestId = numericId(requestValue, 'requestId');
  const result = await (await db()).query(`select s.id,s.state,s.repositories_found,s.error,s.requested_at,s.started_at,s.completed_at,
      count(c.id)::int as candidate_count from tracemini_scan_requests s left join tracemini_repository_candidates c on c.scan_id=s.id
      where s.id=$1 and s.company_id=$2 and s.user_id=$3
      and exists(select 1 from files_agent_devices d join app_users u on u.id=d.user_id and u.company_id=d.company_id and u.approval_status='approved'
        where d.id=s.device_id and d.user_id=$3 and d.company_id=$2 and d.revoked_at is null) group by s.id`, [requestId, session.company_id, session.id]);
  if (!result.rows[0]) throw new ProjectServiceError('Scan not found', 404, 'not_found');
  const row = result.rows[0];
  return { requestId: String(row.id), state: row.state, count: Number(row.repositories_found ?? row.candidate_count ?? 0), error: row.error || null,
    requestedAt: iso(row.requested_at), startedAt: iso(row.started_at), completedAt: iso(row.completed_at) };
}

export async function listRepositoryCandidates(session: SessionUser) {
  // Derive browser confirmation from current authority in one statement/snapshot.
  const result = await (await db()).query(`select c.id,c.display_name,c.repository_key,c.branch,c.head_sha,c.upstream_head_sha,
      case when access.n=1 then 'matched' when access.n>1 then 'ambiguous' else 'unmatched' end as match_status,
      case when access.n=1 then access.project_id else null end as matched_project_id,
      case when access.n<>1 or access.project_id is distinct from c.matched_project_id then 'unselected'
        when c.tracking_state='tracking' and not exists (
          select 1 from project_tracemini_roots r where r.project_id=access.project_id and r.device_id=c.device_id
          and r.repository_key=c.repository_key and r.status='approved' and r.revoked_at is null
          and r.binding_id is not null and r.binding_secret_hash is not null
          and r.root_hash=encode(sha256(convert_to('tracemini-discovery-candidate:'||c.id::text,'UTF8')),'hex')
        ) then 'stopped' else c.tracking_state end as tracking_state,
      c.revision,c.created_at from tracemini_repository_candidates c
      join files_agent_devices d on d.id=c.device_id and d.company_id=c.company_id and d.user_id=$2 and d.revoked_at is null
      join app_users u on u.id=d.user_id and u.company_id=d.company_id and u.approval_status='approved'
      cross join lateral (select count(*) as n,min(p.id) as project_id from projects p
        join app_users owner on owner.id=p.client_id and owner.company_id=$1
        where p.approval_status='approved' and (case when c.explicit_project_id is not null then p.id=c.explicit_project_id else p.git_repository_key=c.repository_key end)
        and (p.client_id=$2 or exists(select 1 from project_memberships m
          where m.project_id=p.id and m.user_id=$2 and m.membership_status='active'))) access
      where c.company_id=$1 order by c.created_at desc limit 500`, [session.company_id, session.id]);
  return result.rows.map((row) => ({ ...row, id: String(row.id), matched_project_id: row.matched_project_id ? String(row.matched_project_id) : null,
    revision: Number(row.revision), created_at: new Date(row.created_at).toISOString() }));
}

export async function selectRepositoryCandidate(session: SessionUser, candidateValue: unknown, desired: boolean, revisionValue: unknown, requireNode = false) {
  const candidateId = numericId(candidateValue, 'candidateId');
  const revision = Number(revisionValue);
  if (!Number.isSafeInteger(revision) || revision < 1) invalid('revision is invalid');
  return transaction(async (client) => {
    if(requireNode){
      const live=await client.query(`select n.id from tracemini_node_devices n join files_agent_devices d on d.node_device_id=n.id and d.user_id=n.user_id and d.company_id=n.company_id join tracemini_repository_candidates c on c.device_id=d.id and c.company_id=d.company_id join app_users u on u.id=d.user_id and u.company_id=d.company_id and u.approval_status='approved' where c.id=$1 and n.user_id=$2 and n.company_id=$3 and n.capability='node-git-v1' and n.revoked_at is null and n.expires_at>now() and d.revoked_at is null for update of n,d,c`,[candidateId,session.id,session.company_id]);
      if(!live.rowCount)throw new ProjectServiceError('Active Node candidate unavailable',404,'not_found');
    }
    const candidate = await client.query(`select c.repository_key from tracemini_repository_candidates c join files_agent_devices d on d.id=c.device_id
      where c.id=$1 and c.company_id=$2 and d.company_id=$2 and d.user_id=$3 and d.revoked_at is null for update of c,d`, [candidateId,session.company_id,session.id]);
    if (!candidate.rows[0] || (desired && !await authorizedMatch(client,session.company_id,session.id,candidate.rows[0].repository_key,candidateId)))
      throw new ProjectServiceError('Candidate is not an authorized unique project match',409,'selection_unavailable');
    const result = await client.query(`update tracemini_repository_candidates c set tracking_state='pending',revision=c.revision+1,updated_at=now()
      from files_agent_devices d where c.id=$1 and c.device_id=d.id and c.company_id=$2 and d.user_id=$3 and d.revoked_at is null and c.revision=$4
      returning c.id,c.revision`, [candidateId, session.company_id, session.id, revision]);
    if (!result.rows[0]) throw new ProjectServiceError('Candidate changed or unavailable', 409, 'revision_conflict');
    const nextRevision = Number(result.rows[0].revision);
    await client.query(`insert into tracemini_repository_selections(candidate_id,owner_user_id,desired_tracking,revision,claimed_at,completed_at)
      values($1,$2,$3,$4,null,null) on conflict(candidate_id) do update set owner_user_id=excluded.owner_user_id,desired_tracking=excluded.desired_tracking,
      revision=excluded.revision,claimed_at=null,claim_token=null,completed_at=null,updated_at=now()`, [candidateId, session.id, desired, nextRevision]);
    if (!desired) await client.query(`update project_tracemini_roots set status='revoked',revoked_at=now() where device_id in(select device_id from tracemini_repository_candidates where id=$1) and root_hash=$2`, [candidateId,discoveryRootHash(candidateId)]);
    return { candidateId, desiredTracking: desired, revision: nextRevision };
  });
}

export async function claimDeviceWork(credential: DiscoveryCredential) {
  return transaction(async (client) => {
    const device = await deviceForCredential(client, credential);
    // Idle devices have no binding heartbeat; valid work polls are liveness too.
    // The credential row is locked above, so concurrent polls cannot amplify writes.
    await client.query(`update files_agent_devices set last_seen_at=now() where id=$1
      and (last_seen_at is null or last_seen_at<now()-interval '30 seconds')`, [device.id]);
    const work: Record<string, unknown>[] = [];
    const scan = await client.query(`update tracemini_scan_requests set state='running',started_at=coalesce(started_at,now()),claimed_at=now(),claim_token=md5(random()::text||clock_timestamp()::text)
      where id=(select id from tracemini_scan_requests where device_id=$1 and user_id=$2 and company_id=$3 and (state='queued' or (state='running' and (claimed_at is null or claimed_at<now()-interval '10 minutes'))) order by requested_at for update skip locked limit 1)
      returning id,claim_token`, [device.id,device.user_id,device.company_id]);
    if (scan.rows[0]) work.push({ work_id: String(scan.rows[0].id), kind: 'scan', claim_token: scan.rows[0].claim_token });
    const selections = await client.query(`update tracemini_repository_selections s set claimed_at=now(),claim_token=md5(random()::text||clock_timestamp()::text)
      from tracemini_repository_candidates c where s.candidate_id=c.id and c.device_id=$1 and s.owner_user_id=$2 and s.revision=c.revision and s.completed_at is null
      and (s.claimed_at is null or s.claimed_at<now()-interval '10 minutes') returning s.candidate_id,s.revision,s.desired_tracking,s.claim_token,c.repository_key,c.fingerprint`, [device.id, device.user_id]);
    for (const row of selections.rows) {
      const project = await authorizedMatch(client,device.company_id,device.user_id,row.repository_key,String(row.candidate_id));
      if (row.desired_tracking && !project) {
        await client.query(`update tracemini_repository_candidates set tracking_state='stopped',matched_project_id=null,match_status='unmatched',revision=revision+1 where id=$1`, [row.candidate_id]);
        await client.query(`update project_tracemini_roots set status='revoked',revoked_at=now() where device_id=$1 and root_hash=$2`, [device.id,discoveryRootHash(String(row.candidate_id))]);
        continue;
      }
      const binding = row.desired_tracking ? await deviceBinding(client,device,String(row.candidate_id),project!,row.repository_key) : undefined;
      await client.query(`update tracemini_repository_candidates set matched_project_id=$2 where id=$1`, [row.candidate_id,project]);
      work.push({ work_id: String(row.candidate_id), kind: 'selection', revision: Number(row.revision), desired_tracking: row.desired_tracking, claim_token: row.claim_token, repository_key: row.repository_key, fingerprint: row.fingerprint, ...(binding ? {binding} : {}) });
    }
    const pushes = await client.query(`update tracemini_pending_pushes p set attempts=p.attempts+1,next_check_at=now()+interval '5 minutes',claim_token=md5(random()::text||clock_timestamp()::text)
      from tracemini_repository_candidates c where p.candidate_id=c.id and c.device_id=$1 and p.status='pending' and p.next_check_at<=now()
      returning p.id,p.candidate_id,p.expected_head_sha,p.branch,p.claim_token,p.created_at,c.repository_key,c.fingerprint`, [device.id]);
    for (const row of pushes.rows) work.push({ work_id: String(row.id), kind: 'push', candidate_id: String(row.candidate_id), expected_head_sha: row.expected_head_sha, branch: row.branch, claim_token: row.claim_token, occurred_at: new Date(row.created_at).toISOString(), repository_key: row.repository_key, fingerprint: row.fingerprint });
    return { work };
  });
}

function repositoryInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('repository entry must be an object');
  return value as Record<string, unknown>;
}
export async function publishRepositoryCandidates(credential: DiscoveryCredential, body: Record<string, unknown>) {
  const repositories = body.repositories;
  if (!Array.isArray(repositories) || repositories.length > MAX_REPOSITORIES) invalid('repositories must contain at most 500 entries');
  const scanId = numericId(body.scan_id, 'scan_id');
  const claimToken = text(body.claim_token, 'claim_token',80,true)!;
  return transaction(async (client) => {
    const device = await deviceForCredential(client, credential);
    const scan = await client.query(`select id from tracemini_scan_requests where id=$1 and device_id=$2 and company_id=$3 and user_id=$5 and state='running' and claim_token=$4 for update`, [scanId, device.id, device.company_id,claimToken,device.user_id]);
    if (!scan.rows[0]) throw new ProjectServiceError('Scan is not active for this device', 409, 'scan_unavailable');
    let accepted = 0;
    for (const raw of repositories) {
      const item = repositoryInput(raw);
      const key = canonicalKey(item.repository_key);
      const name = text(item.display_name ?? item.name, 'display_name', 160, true)!;
      const fp = fingerprint(item.fingerprint);
      const values = [scanId, device.company_id, device.id, name, key, text(item.branch, 'branch', 200), sha(item.head_sha, 'head_sha'), sha(item.upstream_head_sha, 'upstream_head_sha'), sha(item.remote_branch_sha, 'remote_branch_sha'), text(item.reflog_action, 'reflog_action', 200), JSON.stringify(fp)];
      const saved = await client.query(`insert into tracemini_repository_candidates(scan_id,company_id,device_id,display_name,repository_key,branch,head_sha,upstream_head_sha,remote_branch_sha,reflog_action,fingerprint)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) on conflict(device_id,repository_key,fingerprint) do update set scan_id=excluded.scan_id,company_id=excluded.company_id,
        display_name=excluded.display_name,branch=excluded.branch,head_sha=excluded.head_sha,upstream_head_sha=excluded.upstream_head_sha,remote_branch_sha=excluded.remote_branch_sha,
        reflog_action=excluded.reflog_action,updated_at=now() returning id,matched_project_id,match_status`, values);
      const candidateId = saved.rows[0].id;
      await client.query(`update tracemini_repository_candidates set matched_project_id=null,match_status='unmatched' where id=$1`, [candidateId]);
      await client.query(`with matches as (select p.id,count(*) over() as n from projects p join app_users owner on owner.id=p.client_id and owner.company_id=$3
        left join project_memberships m on m.project_id=p.id and m.user_id=$2 and m.membership_status='active'
        where p.approval_status='approved' and (case when (select explicit_project_id from tracemini_repository_candidates where id=$1) is not null then p.id=(select explicit_project_id from tracemini_repository_candidates where id=$1) else p.git_repository_key=$4 end) and (p.client_id=$2 or m.user_id=$2))
        update tracemini_repository_candidates c set match_status=case when matches.n=1 then 'matched' when matches.n>1 then 'ambiguous' else 'unmatched' end,
        matched_project_id=case when matches.n=1 then matches.id else null end,updated_at=now() from matches where c.id=$1`, [candidateId, device.user_id, device.company_id, key]);
      const changed = await client.query(`update tracemini_repository_candidates set revision=revision+1,tracking_state='unselected'
        where id=$1 and (matched_project_id is distinct from $2::bigint or match_status is distinct from $3::text) returning id`, [candidateId,saved.rows[0].matched_project_id,saved.rows[0].match_status]);
      if (changed.rowCount) {
        await client.query(`delete from tracemini_tracked_repositories where candidate_id=$1`, [candidateId]);
        await client.query(`update project_tracemini_roots set status='revoked',revoked_at=now() where device_id=$1 and root_hash=$2`, [device.id,discoveryRootHash(String(candidateId))]);
      }
      await client.query(`insert into tracemini_repository_fingerprints(candidate_id,device_id,fingerprint,observed_at) values($1,$2,$3::jsonb,now())
        on conflict(candidate_id) do update set device_id=excluded.device_id,fingerprint=excluded.fingerprint,observed_at=now()`, [candidateId, device.id, JSON.stringify(fp)]);
      accepted += 1;
    }
    return { accepted };
  });
}

export async function completeDeviceWork(credential: DiscoveryCredential, body: Record<string, unknown>) {
  const kind = body.kind;
  if (kind !== 'scan' && kind !== 'selection' && kind !== 'push') invalid('kind is invalid');
  const workId = numericId(body.work_id, 'work_id');
  const claimToken = text(body.claim_token, 'claim_token', 80, true)!;
  return transaction(async (client) => {
    const device = await deviceForCredential(client, credential);
    if (kind === 'scan') {
      const count = body.count;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > MAX_REPOSITORIES) invalid('count is invalid');
      const error = text(body.error, 'error', 240);
      const result = await client.query(`update tracemini_scan_requests set state=$4,repositories_found=$3,completed_at=now(),error=$5
        where id=$1 and device_id=$2 and company_id=$6 and user_id=$8 and state='running' and claim_token=$7 returning id`, [workId, device.id, count, error ? 'error' : 'completed', error, device.company_id, claimToken,device.user_id]);
      if (!result.rowCount) throw new ProjectServiceError('Scan unavailable or stale', 409, 'scan_unavailable');
    } else if (kind === 'selection') {
      const revision = Number(body.revision);
      if (!Number.isSafeInteger(revision) || revision < 1 || typeof body.tracked !== 'boolean') invalid('selection completion is invalid');
      const result = await client.query(`select c.id,c.matched_project_id,c.repository_key,c.fingerprint,s.desired_tracking,s.claim_token from tracemini_repository_candidates c
        join tracemini_repository_selections s on s.candidate_id=c.id where c.id=$1 and c.device_id=$2 and s.owner_user_id=$5 and c.company_id=$6 and c.revision=s.revision and s.revision=$3 and s.claim_token=$4 and s.completed_at is null for update`, [workId, device.id, revision, claimToken,device.user_id,device.company_id]);
      const row = result.rows[0];
      if (!row || (!body.error && row.desired_tracking !== body.tracked)) throw new ProjectServiceError('Selection unavailable or stale', 409, 'selection_unavailable');
      if (body.error && body.tracked) invalid('failed activation cannot be tracked');
      if (body.error && !row.desired_tracking) throw new ProjectServiceError('Device has not acknowledged successful stop cleanup',409,'stop_acknowledgement_required');
      if (body.tracked && (!row.matched_project_id || await authorizedMatch(client,device.company_id,device.user_id,row.repository_key,workId) !== String(row.matched_project_id))) throw new ProjectServiceError('Candidate is not an authorized project match', 409, 'selection_unavailable');
      if (!body.tracked) await client.query(`update project_tracemini_roots set status='revoked',revoked_at=now() where device_id=$1 and root_hash=$2`, [device.id,discoveryRootHash(workId)]);
      await client.query(`update tracemini_repository_candidates set tracking_state=$2,updated_at=now() where id=$1`, [workId, body.tracked ? 'tracking' : 'stopped']);
      if (body.tracked) await client.query(`insert into tracemini_tracked_repositories(candidate_id,project_id,device_id,repository_key,fingerprint) values($1,$2,$3,$4,$5::jsonb)
        on conflict(candidate_id) do update set project_id=excluded.project_id,device_id=excluded.device_id,repository_key=excluded.repository_key,fingerprint=excluded.fingerprint,updated_at=now()`, [workId, row.matched_project_id, device.id, row.repository_key, JSON.stringify(row.fingerprint)]);
      else await client.query(`delete from tracemini_tracked_repositories where candidate_id=$1 and device_id=$2`, [workId, device.id]);
      await client.query(`update tracemini_repository_selections set completed_at=now(),updated_at=now() where candidate_id=$1 and claim_token=$2`, [workId, claimToken]);
    } else {
      const expected = sha(body.expected_head_sha, 'expected_head_sha', true)!;
      const branch = pushRef(body.branch);
      const status = body.status === 'verified' ? 'verified' : body.status === 'failed' ? 'failed' : body.status === 'pending' ? 'pending' : invalid('push status is invalid');
      const result = await client.query(`update tracemini_pending_pushes p set status=$2,verified_at=case when $2='verified' then now() else null end
        where p.id=$1 and p.status='pending' and p.expected_head_sha=$3 and p.branch=$4 and p.claim_token=$5 and exists(select 1 from tracemini_repository_candidates c where c.id=p.candidate_id and c.device_id=$6)
        returning p.id`, [workId, status, expected, branch, claimToken, device.id]);
      if (!result.rowCount) throw new ProjectServiceError('Push unavailable or stale', 409, 'push_unavailable');
    }
    return { completed: true, workId };
  });
}

export async function createPendingPush(credential: DiscoveryCredential, body: Record<string, unknown>) {
  const key = canonicalKey(body.repository_key);
  const branch = pushRef(body.branch);
  const expected = sha(body.expected_head_sha, 'expected_head_sha', true)!;
  const fp = fingerprint(body.fingerprint);
  return transaction(async (client) => {
    const device = await deviceForCredential(client, credential);
    const result = await client.query(`insert into tracemini_pending_pushes(candidate_id,expected_head_sha,branch,next_check_at)
      select c.id,$3,$4,now() from tracemini_repository_candidates c join tracemini_tracked_repositories t on t.candidate_id=c.id and t.device_id=c.device_id
      where c.device_id=$1 and c.repository_key=$2 and c.fingerprint=$5::jsonb and c.tracking_state='tracking' returning id`, [device.id, key, expected, branch, JSON.stringify(fp)]);
    if (!result.rows[0]) throw new ProjectServiceError('Repository is not tracked for this device and fingerprint', 403, 'forbidden');
    return { pushId: String(result.rows[0].id) };
  });
}
