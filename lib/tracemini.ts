import 'server-only';
import type { SessionUser } from './auth';
import { ensureSchema, getPool } from './db';
import { ProjectServiceError, projectAccessSql } from './projects';
import { traceMiniGet, validateTraceMiniBaseUrl } from './tracemini-adapter';
import { decryptTraceMiniCredential, encryptTraceMiniCredential } from './tracemini-crypto';
import { normalizeTraceMiniData, type TraceMiniProjectMember } from './tracemini-normalize';

const CACHE_TTL_MS = 30_000;
const CACHE_STALE_MAX_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 100;
const PUBLIC_ERRORS = new Set([
  'TraceMini request timed out',
  'TraceMini authorization failed',
  'TraceMini resource was not found',
  'TraceMini returned an invalid response',
  'TraceMini response was too large',
  'TraceMini is temporarily unavailable',
  'TraceMini is unavailable',
]);

type UpstreamData = { dashboard: unknown; activity: unknown[]; repositories: unknown[]; agents: unknown[]; reports: unknown[] };
type CacheEntry = { fetchedAt: number; upstream: UpstreamData; lastSuccessfulSync: string };
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<UpstreamData>>();

type IntegrationRow = {
  project_id: string; client_id: string; base_url: string; workspace_id: string; enabled: boolean;
  credential_ciphertext: Buffer; credential_iv: Buffer; credential_tag: Buffer; credential_version: 1;
  config_generation: string | number; config_revision: string | number;
  last_successful_sync: Date | string | null; last_error: string | null; created_at: Date | string; updated_at: Date | string;
};

function projectId(value: unknown) {
  const result = String(value ?? '');
  if (!/^[1-9]\d*$/.test(result)) throw new ProjectServiceError('Invalid project id');
  return result;
}
function workspaceId(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new ProjectServiceError('Invalid TraceMini workspace ID');
  return value.trim();
}
function timestamp(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function safeError(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const messages: Record<string, string> = {
    timeout: 'TraceMini request timed out',
    unauthorized: 'TraceMini authorization failed',
    not_found: 'TraceMini resource was not found',
    malformed_response: 'TraceMini returned an invalid response',
    too_large: 'TraceMini response was too large',
    temporary_outage: 'TraceMini is temporarily unavailable',
  };
  return messages[code] || 'TraceMini is unavailable';
}
function storedError(value: unknown) {
  if (!value) return null;
  return typeof value === 'string' && PUBLIC_ERRORS.has(value) ? value : 'TraceMini is unavailable';
}
function strictAdmin(session: SessionUser) { return session.role === 'admin' && session.account_type === 'admin'; }
function configurationKey(project: string, row: IntegrationRow) {
  return JSON.stringify([project, String(row.config_generation), String(row.config_revision)]);
}
function invalidateProject(project: string) {
  for (const key of cache.keys()) if (key.startsWith(`["${project}",`)) cache.delete(key);
}
function pruneCache(now: number) {
  for (const [key, entry] of cache) if (now - entry.fetchedAt > CACHE_STALE_MAX_MS) cache.delete(key);
  while (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
}
function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

/** Pure policy helper; database ownership is still checked by every management operation. */
export function isTraceMiniManager(session: Pick<SessionUser, 'id' | 'role' | 'account_type'>, ownerId: string) {
  return (session.role === 'admin' && session.account_type === 'admin') || (session.account_type === 'client' && session.id === String(ownerId));
}

async function ready() { await ensureSchema(); return getPool(); }

async function managementProject(session: SessionUser, project: string) {
  if (session.account_type !== 'client' && !strictAdmin(session)) throw new ProjectServiceError('Forbidden', 403, 'forbidden');
  const db = await ready();
  const result = await db.query(`select id,client_id from projects where id=$1 and approval_status='approved'`, [project]);
  const row = result.rows[0];
  if (!row || !isTraceMiniManager(session, String(row.client_id))) throw new ProjectServiceError('Project not found', 404, 'not_found');
  return { db, ownerId: String(row.client_id) };
}

function publicConfig(row: IntegrationRow | undefined) {
  if (!row) return { configured: false, enabled: false, hasCredential: false, baseUrl: null, workspaceId: null, lastSuccessfulSync: null, lastError: null };
  return {
    configured: true, enabled: row.enabled === true, hasCredential: true,
    baseUrl: row.base_url, workspaceId: row.workspace_id,
    lastSuccessfulSync: timestamp(row.last_successful_sync), lastError: storedError(row.last_error),
    updatedAt: timestamp(row.updated_at),
  };
}

export async function getTraceMiniConfig(session: SessionUser, projectValue: unknown) {
  const project = projectId(projectValue);
  const { db } = await managementProject(session, project);
  const result = await db.query(`select project_id,client_id,base_url,workspace_id,enabled,config_generation,config_revision,last_successful_sync,last_error,created_at,updated_at from project_tracemini_integrations join projects on projects.id=project_id where project_id=$1`, [project]);
  return publicConfig(result.rows[0]);
}

export async function saveTraceMiniConfig(session: SessionUser, projectValue: unknown, input: Record<string, unknown>) {
  const project = projectId(projectValue);
  const { db } = await managementProject(session, project);
  let baseUrl: string;
  try {
    baseUrl = validateTraceMiniBaseUrl(input.baseUrl);
  } catch (error) {
    const message = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : 'Invalid TraceMini base URL';
    throw new ProjectServiceError(message, 400, 'invalid_request');
  }
  const workspace = workspaceId(input.workspaceId);
  const existing = await db.query(`select credential_version,project_id,base_url,workspace_id,enabled,config_generation,config_revision,credential_ciphertext,credential_iv,credential_tag from project_tracemini_integrations where project_id=$1`, [project]);
  const credential = typeof input.credential === 'string' ? input.credential.trim() : '';
  if (!existing.rows[0] && !credential) throw new ProjectServiceError('A TraceMini credential is required');
  let credentialChanged = Boolean(credential);
  if (credential && existing.rows[0]) {
    try { credentialChanged = credential !== decrypt(project, existing.rows[0] as IntegrationRow); }
    catch { credentialChanged = true; }
  }
  if (credentialChanged) {
    const envelope = encryptTraceMiniCredential(project, credential);
    await db.query(
      `insert into project_tracemini_integrations(project_id,base_url,workspace_id,credential_ciphertext,credential_iv,credential_tag,credential_version,enabled,last_error)
       values($1,$2,$3,$4,$5,$6,$7,coalesce($8,true),null)
       on conflict(project_id) do update set
         config_revision=project_tracemini_integrations.config_revision+case when
           row(project_tracemini_integrations.base_url,project_tracemini_integrations.workspace_id,project_tracemini_integrations.credential_ciphertext,project_tracemini_integrations.credential_iv,project_tracemini_integrations.credential_tag,project_tracemini_integrations.credential_version,project_tracemini_integrations.enabled)
           is distinct from row(excluded.base_url,excluded.workspace_id,excluded.credential_ciphertext,excluded.credential_iv,excluded.credential_tag,excluded.credential_version,coalesce($8,project_tracemini_integrations.enabled))
           then 1 else 0 end,
         updated_at=case when
           row(project_tracemini_integrations.base_url,project_tracemini_integrations.workspace_id,project_tracemini_integrations.credential_ciphertext,project_tracemini_integrations.credential_iv,project_tracemini_integrations.credential_tag,project_tracemini_integrations.credential_version,project_tracemini_integrations.enabled)
           is distinct from row(excluded.base_url,excluded.workspace_id,excluded.credential_ciphertext,excluded.credential_iv,excluded.credential_tag,excluded.credential_version,coalesce($8,project_tracemini_integrations.enabled))
           then now() else project_tracemini_integrations.updated_at end,
         base_url=excluded.base_url,workspace_id=excluded.workspace_id,credential_ciphertext=excluded.credential_ciphertext,credential_iv=excluded.credential_iv,credential_tag=excluded.credential_tag,credential_version=excluded.credential_version,enabled=coalesce($8,project_tracemini_integrations.enabled),last_error=null`,
      [project, baseUrl, workspace, envelope.ciphertext, envelope.iv, envelope.tag, envelope.version, typeof input.enabled === 'boolean' ? input.enabled : null],
    );
  } else {
    await db.query(
      `update project_tracemini_integrations set
         config_revision=project_tracemini_integrations.config_revision+case when row(base_url,workspace_id,enabled) is distinct from row($2,$3,coalesce($4,enabled)) then 1 else 0 end,
         updated_at=case when row(base_url,workspace_id,enabled) is distinct from row($2,$3,coalesce($4,enabled)) then now() else updated_at end,
         base_url=$2,workspace_id=$3,enabled=coalesce($4,enabled),last_error=null
       where project_id=$1`,
      [project, baseUrl, workspace, typeof input.enabled === 'boolean' ? input.enabled : null],
    );
  }
  invalidateProject(project);
  return getTraceMiniConfig(session, project);
}

async function integrationForManager(session: SessionUser, project: string): Promise<{ db: Awaited<ReturnType<typeof ready>>; row: IntegrationRow }> {
  const { db } = await managementProject(session, project);
  const result = await db.query(`select i.*,p.client_id from project_tracemini_integrations i join projects p on p.id=i.project_id where i.project_id=$1`, [project]);
  if (!result.rows[0]) throw new ProjectServiceError('TraceMini is not configured', 404, 'not_found');
  return { db, row: result.rows[0] };
}
function decrypt(project: string, row: IntegrationRow) {
  return decryptTraceMiniCredential(project, { version: Number(row.credential_version) as 1, ciphertext: row.credential_ciphertext, iv: row.credential_iv, tag: row.credential_tag });
}

export async function testTraceMiniConnection(session: SessionUser, projectValue: unknown) {
  const project = projectId(projectValue);
  const { db, row } = await integrationForManager(session, project);
  const generation = row.config_generation;
  const revision = row.config_revision;
  try {
    const credential = decrypt(project, row);
    const payload = await traceMiniGet(row.base_url, credential, 'workspaces');
    if (!Array.isArray(payload) || !payload.some((workspace) => workspace && typeof workspace === 'object' && String((workspace as Record<string, unknown>).id) === row.workspace_id)) throw new Error('Configured TraceMini workspace was not returned');
    const dashboard = await traceMiniGet(row.base_url, credential, 'dashboard', row.workspace_id);
    if (!dashboard || typeof dashboard !== 'object' || Array.isArray(dashboard)) throw new Error('Invalid TraceMini dashboard response');
  } catch (error) {
    const message = safeError(error);
    const updated = await db.query(
      `update project_tracemini_integrations set last_error=$2 where project_id=$1 and config_generation=$3 and config_revision=$4 returning project_id`,
      [project, message, generation, revision],
    ).catch(() => null);
    if (updated && !updated.rows[0]) throw new ProjectServiceError('TraceMini configuration changed during connection test', 409, 'config_superseded');
    throw new ProjectServiceError(message, 502, 'tracemini_unavailable');
  }
  const updated = await db.query(
    `update project_tracemini_integrations set last_error=null where project_id=$1 and config_generation=$2 and config_revision=$3 returning project_id`,
    [project, generation, revision],
  ).catch(() => null);
  if (!updated) throw new ProjectServiceError('TraceMini is unavailable', 502, 'tracemini_unavailable');
  if (!updated.rows[0]) throw new ProjectServiceError('TraceMini configuration changed during connection test', 409, 'config_superseded');
  return { connected: true, workspaceVerified: true };
}

export async function setTraceMiniEnabled(session: SessionUser, projectValue: unknown, enabled: boolean) {
  const project = projectId(projectValue);
  const { db } = await managementProject(session, project);
  const result = await db.query(
    `update project_tracemini_integrations set
       config_revision=config_revision+case when enabled is distinct from $2 then 1 else 0 end,
       updated_at=case when enabled is distinct from $2 then now() else updated_at end,
       enabled=$2
     where project_id=$1 returning project_id`,
    [project, enabled],
  );
  if (!result.rows[0]) throw new ProjectServiceError('TraceMini is not configured', 404, 'not_found');
  invalidateProject(project);
  return getTraceMiniConfig(session, project);
}

export async function removeTraceMiniConfig(session: SessionUser, projectValue: unknown) {
  const project = projectId(projectValue);
  const { db } = await managementProject(session, project);
  await db.query(`delete from project_tracemini_integrations where project_id=$1`, [project]);
  invalidateProject(project);
  return { removed: true };
}

async function readableIntegration(session: SessionUser, project: string) {
  const db = await ready();
  const access = projectAccessSql('$2'); // helper enforces membership_status='active' and approved-project owner/member access
  const admin = strictAdmin(session);
  const result = await db.query(
    `select i.*,p.id as authorized_project_id,p.client_id from projects p left join project_tracemini_integrations i on i.project_id=p.id ${admin ? '' : access.join}
     where p.id=$1 and p.approval_status='approved' and ${admin ? 'true' : access.predicate}`,
    admin ? [project] : [project, session.id],
  );
  const resultRow = result.rows[0] as (IntegrationRow & { authorized_project_id: string }) | undefined;
  if (!resultRow) throw new ProjectServiceError('Project not found', 404, 'not_found');
  return { db, row: resultRow.project_id ? resultRow : null };
}

async function projectMembers(db: Awaited<ReturnType<typeof ready>>, project: string): Promise<TraceMiniProjectMember[]> {
  const result = await db.query(
    `select u.id,u.email,u.display_name from projects p join app_users u on u.id=p.client_id where p.id=$1
     union
     select u.id,u.email,u.display_name from project_memberships pm join app_users u on u.id=pm.user_id where pm.project_id=$1 and pm.membership_status='active'`,
    [project],
  );
  return result.rows.map((row) => ({ id: String(row.id), email: String(row.email), display_name: row.display_name }));
}

function assertArray(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new Error(`Invalid TraceMini ${label} response`);
  return value;
}

async function fetchUpstream(project: string, row: IntegrationRow): Promise<UpstreamData> {
  const key = configurationKey(project, row);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const request = (async () => {
    const credential = decrypt(project, row);
    const [dashboard, activity, repositories, agents, reports] = await Promise.all([
      traceMiniGet(row.base_url, credential, 'dashboard', row.workspace_id),
      traceMiniGet(row.base_url, credential, 'activity', row.workspace_id),
      traceMiniGet(row.base_url, credential, 'repositories', row.workspace_id),
      traceMiniGet(row.base_url, credential, 'agents', row.workspace_id),
      traceMiniGet(row.base_url, credential, 'reports', row.workspace_id),
    ]);
    if (!dashboard || typeof dashboard !== 'object' || Array.isArray(dashboard)) throw new Error('Invalid TraceMini dashboard response');
    return { dashboard, activity: assertArray(activity, 'activity'), repositories: assertArray(repositories, 'repositories'), agents: assertArray(agents, 'agents'), reports: assertArray(reports, 'reports') };
  })();
  inFlight.set(key, request);
  try { return await request; } finally { if (inFlight.get(key) === request) inFlight.delete(key); }
}

async function configurationIsCurrent(session: SessionUser, project: string, expected: string) {
  try {
    const current = await readableIntegration(session, project);
    return Boolean(current.row && current.row.enabled && configurationKey(project, current.row) === expected);
  } catch { return false; }
}

async function normalized(db: Awaited<ReturnType<typeof ready>>, project: string, upstream: UpstreamData) {
  return normalizeTraceMiniData(upstream, await projectMembers(db, project));
}

export async function getTraceMiniData(session: SessionUser, projectValue: unknown) {
  const project = projectId(projectValue);
  const { db, row } = await readableIntegration(session, project);
  if (!row) return { state: 'unconfigured', stale: false, lastSuccessfulSync: null, lastError: null, data: null };
  if (!row.enabled) return { state: 'disabled', stale: false, lastSuccessfulSync: timestamp(row.last_successful_sync), lastError: storedError(row.last_error), data: null };
  const key = configurationKey(project, row);
  const now = Date.now();
  pruneCache(now);
  const cached = cache.get(key);
  try {
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      const data = await normalized(db, project, cached.upstream);
      if (await configurationIsCurrent(session, project, key)) return { state: 'fresh', stale: false, lastSuccessfulSync: cached.lastSuccessfulSync, lastError: null, data };
      return { state: 'unavailable', stale: false, lastSuccessfulSync: timestamp(row.last_successful_sync), lastError: 'TraceMini is unavailable', data: null };
    }
    const upstream = await fetchUpstream(project, row);
    const data = await normalized(db, project, upstream);
    if (!await configurationIsCurrent(session, project, key)) return { state: 'unavailable', stale: false, lastSuccessfulSync: timestamp(row.last_successful_sync), lastError: 'TraceMini is unavailable', data: null };
    const successfulAt = new Date().toISOString();
    const updated = await db.query(
      `update project_tracemini_integrations set last_successful_sync=$2,last_error=null where project_id=$1 and config_generation=$3 and config_revision=$4 and enabled=true returning project_id`,
      [project, successfulAt, row.config_generation, row.config_revision],
    ).catch(() => ({ rows: [] }));
    if (!updated.rows[0]) return { state: 'unavailable', stale: false, lastSuccessfulSync: timestamp(row.last_successful_sync), lastError: 'TraceMini is unavailable', data: null };
    pruneCache(Date.now());
    cache.set(key, { fetchedAt: Date.now(), upstream, lastSuccessfulSync: successfulAt });
    return { state: 'fresh', stale: false, lastSuccessfulSync: successfulAt, lastError: null, data };
  } catch (error) {
    const message = safeError(error);
    const current = await configurationIsCurrent(session, project, key);
    if (current) await db.query(
      `update project_tracemini_integrations set last_error=$2 where project_id=$1 and config_generation=$3 and config_revision=$4 and enabled=true`,
      [project, message, row.config_generation, row.config_revision],
    ).catch(() => undefined);
    const canServeStale = current && !['unauthorized', 'not_found'].includes(errorCode(error)) && cached && Date.now() - cached.fetchedAt <= CACHE_STALE_MAX_MS;
    if (canServeStale && cached) {
      try { return { state: 'stale', stale: true, lastSuccessfulSync: cached.lastSuccessfulSync, lastError: message, data: await normalized(db, project, cached.upstream) }; }
      catch { /* Current identity data is required before cached upstream data is browser-safe. */ }
    }
    if (cached) cache.delete(key);
    return { state: 'unavailable', stale: false, lastSuccessfulSync: timestamp(row.last_successful_sync), lastError: message, data: null };
  }
}
