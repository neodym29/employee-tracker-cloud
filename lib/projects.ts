import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import type { SessionUser } from './auth';
import { ensureSchema, getPool } from './db';

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 4000;
export const RECORD_TITLE_MAX = 160;
export const RECORD_BODY_MAX_BYTES = 64 * 1024;
const FILENAME_MAX = 255;
const MEDIA_TYPE_MAX = 255;
const STORAGE_KEY_MAX = 1024;
const ARTIFACT_SIZE_MAX = 1_000_000_000_000;
const STATUSES = new Set(['draft', 'open', 'active', 'completed', 'archived']);

export class ProjectServiceError extends Error {
  constructor(message: string, public status = 400, public code = 'invalid_request') {
    super(message);
  }
}

function text(value: unknown, field: string, max: number, allowEmpty = false) {
  if (typeof value !== 'string') throw new ProjectServiceError(`${field} is required`);
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > max) {
    throw new ProjectServiceError(`${field} must be ${allowEmpty ? `at most ${max}` : `between 1 and ${max}`} characters`);
  }
  return normalized;
}

function id(value: unknown, field = 'id') {
  const normalized = String(value ?? '');
  if (!/^[1-9]\d*$/.test(normalized)) throw new ProjectServiceError(`Invalid ${field}`);
  return normalized;
}

function requireType(session: SessionUser, type: SessionUser['account_type']) {
  if (session.account_type !== type) throw new ProjectServiceError('Forbidden', 403, 'forbidden');
}

function requirePlatformAdmin(session: SessionUser) {
  if (session.role !== 'admin' || session.account_type !== 'admin') {
    throw new ProjectServiceError('Forbidden', 403, 'forbidden');
  }
}

/** Shared owner-or-active-member policy used by every protected project resource query. */
export function projectAccessSql(userParameter: string, projectAlias = 'p', membershipAlias = 'access_membership') {
  return {
    join: `left join project_memberships ${membershipAlias} on ${membershipAlias}.project_id=${projectAlias}.id and ${membershipAlias}.user_id=${userParameter} and ${membershipAlias}.membership_status='active'`,
    predicate: `(${projectAlias}.client_id=${userParameter} or ${membershipAlias}.user_id=${userParameter})`,
  };
}

type ProjectReadOptions = { platformAudit?: boolean };
type ProjectAccessOptions = { ownerOnly?: boolean };

async function assertProjectAccess(
  db: Pick<PoolClient, 'query'>,
  session: SessionUser,
  projectId: string,
  options: ProjectAccessOptions = {},
) {
  const result = options.ownerOnly
    ? await db.query(
        `select 1 from projects p where p.id=$1 and p.client_id=$2`,
        [projectId, session.id],
      )
    : await db.query(
        `select 1 from projects p ${projectAccessSql('$2').join}
         where p.id=$1 and ${projectAccessSql('$2').predicate}`,
        [projectId, session.id],
      );
  if (!result.rows[0]) throw new ProjectServiceError('Project not found', 404, 'not_found');
}

function recordBody(body: unknown) {
  let encoded: string;
  try {
    encoded = JSON.stringify(body);
  } catch {
    throw new ProjectServiceError('Record body must be valid JSON');
  }
  if (encoded === undefined) throw new ProjectServiceError('Record body must be valid JSON');
  // Bound UTF-8 bytes, not JavaScript character count.
  if (Buffer.byteLength(encoded, 'utf8') > RECORD_BODY_MAX_BYTES) throw new ProjectServiceError('Record body exceeds 64KB');
  return encoded;
}

async function ready() {
  await ensureSchema();
  return getPool();
}

export async function createProject(session: SessionUser, input: { clientId?: unknown; title?: unknown; description?: unknown; status?: unknown }) {
  const title = text(input.title, 'Title', TITLE_MAX);
  const description = text(input.description ?? '', 'Description', DESCRIPTION_MAX, true);
  if (session.account_type === 'engineer') {
    const clientId = id(input.clientId, 'client id');
    const pool = await ready();
    const client: PoolClient = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query('begin');
      transactionStarted = true;
      // Serialize proposals for this engineer/client pair. The duplicate lookup must run
      // after this transaction-scoped lock so concurrent retries cannot both insert.
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`engineer-proposal:${session.id}:${clientId}`]);
      const existingResult = await client.query(
        `select p.id,p.client_id,p.title,p.description,p.status,p.created_at,p.updated_at,
                pm.id as membership_id,pm.project_id as membership_project_id,
                pm.user_id as membership_user_id,pm.membership_type,pm.membership_status,
                pm.created_by as membership_created_by,pm.created_at as membership_created_at
         from projects p join project_memberships pm on pm.project_id=p.id
         where p.client_id=$1 and pm.user_id=$2 and p.title=$3 and p.status='draft'
           and pm.membership_type='request' and pm.membership_status='pending' and pm.created_by=$2
         order by p.created_at asc,p.id asc limit 1`,
        [clientId, session.id, title],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        const project = {
          id: existing.id,
          client_id: existing.client_id,
          title: existing.title,
          description: existing.description,
          status: existing.status,
          created_at: existing.created_at,
          updated_at: existing.updated_at,
        };
        const membership = {
          id: existing.membership_id,
          project_id: existing.membership_project_id,
          user_id: existing.membership_user_id,
          membership_type: existing.membership_type,
          membership_status: existing.membership_status,
          created_by: existing.membership_created_by,
          created_at: existing.membership_created_at,
        };
        await client.query('commit');
        return { ...project, membership };
      }

      // Keep proposals non-public until the client reviews the pending membership request.
      const projectResult = await client.query(
        `insert into projects(client_id,title,description,status)
         select id,$2,$3,$4 from app_users
         where id=$1 and account_type='client' and approval_status='approved'
         returning id,client_id,title,description,status,created_at,updated_at`,
        [clientId, title, description, 'draft'],
      );
      const project = projectResult.rows[0];
      if (!project) throw new ProjectServiceError('Proposal could not be created', 409, 'conflict');
      const membershipResult = await client.query(
        `insert into project_memberships(project_id,user_id,membership_type,membership_status,created_by)
         values($1,$2,'request','pending',$2)
         returning id,project_id,user_id,membership_type,membership_status,created_by,created_at`,
        [project.id, session.id],
      );
      const membership = membershipResult.rows[0];
      if (!membership) throw new ProjectServiceError('Proposal could not be created', 409, 'conflict');
      await client.query('commit');
      return { ...project, membership };
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('rollback');
        } catch {
          // Preserve the primary transaction failure; a broken connection may reject rollback.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
  requireType(session, 'client');
  const status = String(input.status ?? 'draft');
  if (!STATUSES.has(status)) throw new ProjectServiceError('Invalid project status');
  const db = await ready();
  const result = await db.query(
    `insert into projects(client_id,title,description,status) values($1,$2,$3,$4)
     returning id,client_id,title,description,status,created_at,updated_at`,
    [session.id, title, description, status],
  );
  return result.rows[0];
}

export async function updateProject(session: SessionUser, projectId: unknown, input: { title?: unknown; description?: unknown; status?: unknown }) {
  requireType(session, 'client');
  const project = id(projectId, 'project id');
  const title = text(input.title, 'Title', TITLE_MAX);
  const description = text(input.description ?? '', 'Description', DESCRIPTION_MAX, true);
  const status = String(input.status ?? 'draft');
  if (!STATUSES.has(status)) throw new ProjectServiceError('Invalid project status');
  const db = await ready();
  const result = await db.query(
    `update projects set title=$3,description=$4,status=$5,updated_at=now()
     where id=$1 and client_id=$2 returning id,client_id,title,description,status,created_at,updated_at`,
    [project, session.id, title, description, status],
  );
  if (!result.rows[0]) throw new ProjectServiceError('Project not found', 404, 'not_found');
  return result.rows[0];
}

export async function listProjects(session: SessionUser, options: ProjectReadOptions = {}) {
  const db = await ready();
  if (options.platformAudit) {
    requirePlatformAdmin(session);
    return (await db.query(
      `select p.id,p.client_id,p.title,p.description,p.status,p.created_at,p.updated_at
       from projects p order by p.updated_at desc,p.id desc`,
    )).rows;
  }
  if (session.account_type === 'engineer') {
    // Open projects are discoverable summaries. Pending and active membership state is
    // included so the UI can offer the correct action without granting workspace access.
    return (await db.query(
      `select p.id,p.client_id,p.title,p.description,p.status,p.created_at,p.updated_at,
              pm.id as membership_id,pm.membership_type,pm.membership_status
       from projects p
       left join project_memberships pm on pm.project_id=p.id and pm.user_id=$1
       where p.status='open' or pm.user_id=$1
       order by p.updated_at desc,p.id desc`,
      [session.id],
    )).rows;
  }
  if (session.account_type === 'client') {
    return (await db.query(
      `select p.id,p.client_id,p.title,p.description,p.status,p.created_at,p.updated_at,
              null::bigint as membership_id,null::text as membership_type,null::text as membership_status
       from projects p where p.client_id=$1 order by p.updated_at desc,p.id desc`,
      [session.id],
    )).rows;
  }
  return [];
}

export async function getProject(session: SessionUser, projectId: unknown, options: ProjectReadOptions = {}) {
  const db = await ready();
  if (options.platformAudit) {
    requirePlatformAdmin(session);
    const auditResult = await db.query(
      `select p.id,p.client_id,p.title,p.description,p.status,p.created_at,p.updated_at from projects p where p.id=$1`,
      [id(projectId, 'project id')],
    );
    if (!auditResult.rows[0]) throw new ProjectServiceError('Project not found', 404, 'not_found');
    return auditResult.rows[0];
  }
  const access = projectAccessSql('$2');
  const result = await db.query(
    `select distinct p.id,p.client_id,p.title,p.description,p.status,p.created_at,p.updated_at
     from projects p ${access.join}
     where p.id=$1 and ${access.predicate}`,
    [id(projectId, 'project id'), session.id],
  );
  if (!result.rows[0]) throw new ProjectServiceError('Project not found', 404, 'not_found');
  return result.rows[0];
}

export async function listAvailableEngineers(session: SessionUser) {
  requireType(session, 'client');
  const db = await ready();
  return (await db.query(
    `select id,display_name from app_users
     where account_type='engineer' and approval_status='approved'
     order by display_name asc,id asc`,
  )).rows;
}

export async function listAvailableClients(session: SessionUser) {
  requireType(session, 'engineer');
  const db = await ready();
  return (await db.query(
    `select id,display_name from app_users
     where account_type='client' and approval_status='approved'
     order by display_name asc,id asc`,
  )).rows;
}

export async function inviteEngineer(session: SessionUser, projectId: unknown, engineerId: unknown) {
  requireType(session, 'client');
  const db = await ready();
  const result = await db.query(
    `insert into project_memberships(project_id,user_id,membership_type,membership_status,created_by)
     select p.id,u.id,'invitation','pending',$2
     from projects p join app_users u on u.id=$3 and u.account_type='engineer' and u.approval_status='approved'
     where p.id=$1 and p.client_id=$2
     on conflict(project_id,user_id) do nothing
     returning id,project_id,user_id,membership_type,membership_status,created_at`,
    [id(projectId, 'project id'), session.id, id(engineerId, 'engineer id')],
  );
  if (!result.rows[0]) throw new ProjectServiceError('Invitation could not be created', 409, 'conflict');
  return result.rows[0];
}

export async function requestMembership(session: SessionUser, projectId: unknown) {
  requireType(session, 'engineer');
  const db = await ready();
  const result = await db.query(
    `insert into project_memberships(project_id,user_id,membership_type,membership_status,created_by)
     select p.id,$2,'request','pending',$2 from projects p
     where p.id=$1 and p.status='open'
     on conflict(project_id,user_id) do nothing
     returning id,project_id,user_id,membership_type,membership_status,created_at`,
    [id(projectId, 'project id'), session.id],
  );
  if (!result.rows[0]) throw new ProjectServiceError('Request could not be created', 409, 'conflict');
  return result.rows[0];
}

export async function listProjectMemberships(session: SessionUser, projectId: unknown) {
  requireType(session, 'client');
  const project = id(projectId, 'project id');
  const db = await ready();
  await assertProjectAccess(db, session, project, { ownerOnly: true });
  return (await db.query(
    `select pm.id,pm.project_id,pm.user_id,u.display_name,pm.membership_type,pm.membership_status,pm.created_at,pm.responded_at
     from project_memberships pm join projects p on p.id=pm.project_id and p.client_id=$2
     join app_users u on u.id=pm.user_id where pm.project_id=$1 order by pm.created_at desc,pm.id desc`,
    [project, session.id],
  )).rows;
}

export async function respondToMembership(session: SessionUser, projectId: unknown, membershipId: unknown, action: unknown) {
  const project = id(projectId, 'project id');
  const membership = id(membershipId, 'membership id');
  const requestedAction = String(action ?? '');
  const db = await ready();
  let result;
  if (session.account_type === 'engineer' && ['accept', 'decline'].includes(requestedAction)) {
    result = await db.query(
      `update project_memberships pm set membership_status=$4,responded_by=$3,responded_at=now()
       from projects p where pm.id=$2 and pm.project_id=$1 and p.id=pm.project_id
         and pm.user_id=$3 and pm.membership_type='invitation' and pm.membership_status='pending'
       returning pm.id,pm.project_id,pm.user_id,pm.membership_status,pm.responded_at`,
      [project, membership, session.id, requestedAction === 'accept' ? 'active' : 'declined'],
    );
  } else if (session.account_type === 'client' && ['approve', 'reject'].includes(requestedAction)) {
    result = await db.query(
      `update project_memberships pm set membership_status=$4,responded_by=$3,responded_at=now()
       from projects p where pm.id=$2 and pm.project_id=$1 and p.id=pm.project_id and p.client_id=$3
         and pm.membership_type='request' and pm.membership_status='pending'
       returning pm.id,pm.project_id,pm.user_id,pm.membership_status,pm.responded_at`,
      [project, membership, session.id, requestedAction === 'approve' ? 'active' : 'rejected'],
    );
  } else {
    throw new ProjectServiceError('Invalid membership action');
  }
  if (!result.rows[0]) throw new ProjectServiceError('Membership not found', 404, 'not_found');
  return result.rows[0];
}

export async function listRecords(session: SessionUser, projectId: unknown) {
  const project = id(projectId, 'project id');
  const db = await ready();
  await assertProjectAccess(db, session, project);
  const access = projectAccessSql('$2');
  return (await db.query(
    `select resource.id,resource.project_id,resource.record_id,resource.version,resource.title,resource.body,resource.created_by,resource.created_at
     from project_records resource join projects p on p.id=resource.project_id ${access.join}
     where resource.project_id=$1 and ${access.predicate}
     order by resource.record_id,resource.version desc`,
    [project, session.id],
  )).rows;
}

export async function createRecord(session: SessionUser, projectId: unknown, input: { title?: unknown; body?: unknown }) {
  const db = await ready();
  const access = projectAccessSql('$2');
  const result = await db.query(
    `insert into project_records(project_id,record_id,version,title,body,created_by)
     select p.id,$3,1,$4,$5::jsonb,$2 from projects p
     ${access.join}
     where p.id=$1 and ${access.predicate}
     returning id,project_id,record_id,version,title,body,created_by,created_at`,
    [id(projectId, 'project id'), session.id, crypto.randomUUID(), text(input.title, 'Record title', RECORD_TITLE_MAX), recordBody(input.body)],
  );
  if (!result.rows[0]) throw new ProjectServiceError('Project not found', 404, 'not_found');
  return result.rows[0];
}

export async function createRecordVersion(session: SessionUser, projectId: unknown, recordId: unknown, input: { title?: unknown; body?: unknown }) {
  const project = id(projectId, 'project id');
  const record = String(recordId ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(record)) throw new ProjectServiceError('Invalid record id');
  const pool = await ready();
  const client: PoolClient = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`${project}:${record}`]);
    const access = projectAccessSql('$2');
    const result = await client.query(
      `insert into project_records(project_id,record_id,version,title,body,created_by)
       select p.id,$3,coalesce(max(previous.version),0)+1,$4,$5::jsonb,$2
       from projects p join project_records previous on previous.project_id=p.id and previous.record_id=$3
       ${access.join}
       where p.id=$1 and ${access.predicate} group by p.id
       returning id,project_id,record_id,version,title,body,created_by,created_at`,
      [project, session.id, record, text(input.title, 'Record title', RECORD_TITLE_MAX), recordBody(input.body)],
    );
    if (!result.rows[0]) throw new ProjectServiceError('Record not found', 404, 'not_found');
    await client.query('commit');
    return result.rows[0];
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function listArtifacts(session: SessionUser, projectId: unknown) {
  const project = id(projectId, 'project id');
  const db = await ready();
  await assertProjectAccess(db, session, project);
  const access = projectAccessSql('$2');
  return (await db.query(
    `select resource.id,resource.project_id,resource.filename,resource.media_type,resource.size_bytes,resource.sha256,resource.storage_key,resource.created_by,resource.created_at
     from project_artifacts resource join projects p on p.id=resource.project_id ${access.join}
     where resource.project_id=$1 and ${access.predicate}
     order by resource.created_at desc,resource.id desc`,
    [project, session.id],
  )).rows;
}

export async function createArtifact(session: SessionUser, projectId: unknown, input: Record<string, unknown>) {
  const filename = text(input.filename, 'Filename', FILENAME_MAX);
  const mediaType = text(input.mediaType, 'Media type', MEDIA_TYPE_MAX).toLowerCase();
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mediaType)) throw new ProjectServiceError('Invalid media type');
  const size = Number(input.sizeBytes);
  if (!Number.isSafeInteger(size) || size < 0 || size > ARTIFACT_SIZE_MAX) throw new ProjectServiceError('Invalid artifact size');
  const sha256 = String(input.sha256 ?? '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new ProjectServiceError('Invalid sha256');
  const storageKey = input.storageKey == null ? null : text(input.storageKey, 'Storage key', STORAGE_KEY_MAX);
  const db = await ready();
  const access = projectAccessSql('$2');
  const result = await db.query(
    `insert into project_artifacts(project_id,filename,media_type,size_bytes,sha256,storage_key,created_by)
     select p.id,$3,$4,$5,$6,$7,$2 from projects p
     ${access.join}
     where p.id=$1 and ${access.predicate}
     returning id,project_id,filename,media_type,size_bytes,sha256,storage_key,created_by,created_at`,
    [id(projectId, 'project id'), session.id, filename, mediaType, size, sha256, storageKey],
  );
  if (!result.rows[0]) throw new ProjectServiceError('Project not found', 404, 'not_found');
  return result.rows[0];
}

export async function listPendingApprovals(session: SessionUser) {
  requirePlatformAdmin(session);
  const db = await ready();
  return (await db.query(
    `select id,display_name,email,account_type,approval_status,created_at
     from app_users where approval_status='pending' and account_type in ('client','engineer') order by created_at,id`,
  )).rows;
}

export async function reviewAccount(session: SessionUser, userId: unknown, action: unknown) {
  requirePlatformAdmin(session);
  const approval = String(action) === 'approve' ? 'approved' : String(action) === 'reject' ? 'rejected' : null;
  if (!approval) throw new ProjectServiceError('Invalid approval action');
  const db = await ready();
  const result = await db.query(
    `update app_users set approval_status=$3,approved_at=case when $3='approved' then now() else null end,reviewed_at=now(),reviewed_by=$2
     where id=$1 and account_type in ('client','engineer') and approval_status='pending'
     returning id,display_name,email,account_type,approval_status,reviewed_at`,
    [id(userId, 'user id'), session.id, approval],
  );
  if (!result.rows[0]) throw new ProjectServiceError('Account not found', 404, 'not_found');
  return result.rows[0];
}
