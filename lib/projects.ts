import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import type { SessionUser } from './auth';
import { ensureSchema, getPool } from './db';
import { ensureCanonicalProjectDocuments, loadProjectAgentStructuredData } from './project-agent-documents';
import { parseGitRemote } from './git-remote';

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
    predicate: `(${projectAlias}.approval_status='approved' and (${projectAlias}.client_id=${userParameter} or ${membershipAlias}.user_id=${userParameter}))`,
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

function requestUuid(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ProjectServiceError('A valid project creation request key is required');
  }
  return value.toLowerCase();
}

const CREATION_ENGINEER_MAX = 20;

function creationEngineerIds(value: unknown, allowed: boolean) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ProjectServiceError('Engineer selection must be an array');
  if (!allowed && value.length) throw new ProjectServiceError('Engineers cannot select additional project creators');
  if (value.length > CREATION_ENGINEER_MAX) throw new ProjectServiceError(`Select at most ${CREATION_ENGINEER_MAX} engineers`);
  const normalized = value.map((engineerId) => id(engineerId, 'engineer id'));
  if (new Set(normalized).size !== normalized.length) throw new ProjectServiceError('Engineer selection contains duplicates');
  return normalized.sort((left, right) => {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

function creationFingerprint(payload: Record<string, unknown>) {
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

export async function createProject(session: SessionUser, input: { clientId?: unknown; title?: unknown; description?: unknown; status?: unknown; engineerIds?: unknown; requestKey?: unknown; gitRemote?: unknown }) {
  const creationRequestKey = requestUuid(input.requestKey);
  const title = text(input.title, 'Title', TITLE_MAX);
  const description = text(input.description ?? '', 'Description', DESCRIPTION_MAX, true);
  let gitLink: ReturnType<typeof parseGitRemote>;
  try { gitLink = parseGitRemote(input.gitRemote); }
  catch { throw new ProjectServiceError('A valid credential-free Git remote is required'); }
  if (session.account_type !== 'client' && session.account_type !== 'engineer') {
    throw new ProjectServiceError('Forbidden', 403, 'forbidden');
  }
  const engineerCreating = session.account_type === 'engineer';
  const ownerId = engineerCreating ? id(input.clientId, 'client id') : session.id;
  const status = engineerCreating ? 'open' : String(input.status ?? 'draft');
  if (!STATUSES.has(status)) throw new ProjectServiceError('Invalid project status');

  const selectedEngineerIds = creationEngineerIds(input.engineerIds, !engineerCreating);
  const counterpartIds = engineerCreating ? [session.id] : selectedEngineerIds;
  const payloadFingerprint = creationFingerprint({
    version: 3,
    accountType: session.account_type,
    ownerId,
    title,
    description,
    status,
    engineerIds: counterpartIds,
    gitRemoteUrl: gitLink.remoteUrl,
    gitRepositoryKey: gitLink.repositoryKey,
  });

  const pool = await ready();
  const client: PoolClient = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query('begin');
    transactionStarted = true;
    const inserted = engineerCreating
      ? await client.query(
          `insert into projects(client_id,title,description,status,approval_status,proposal_kind,creation_requested_by,creation_request_key,creation_payload_fingerprint,git_remote_url,git_repository_key,progress_percent,progress_summary)
           select id,$2,$3,'open','approved',null,$4,$5::uuid,$6,$7,$8,30,'Project is open for delivery.' from app_users
           where id=$1 and account_type='client' and approval_status='approved'
           on conflict(creation_requested_by,creation_request_key) do nothing
           returning id,client_id,title,description,status,approval_status,git_remote_url,git_repository_key,created_at,updated_at,creation_payload_fingerprint`,
          [ownerId, title, description, session.id, creationRequestKey, payloadFingerprint, gitLink.remoteUrl, gitLink.repositoryKey],
        )
      : await client.query(
          `insert into projects(client_id,title,description,status,approval_status,proposal_kind,creation_requested_by,creation_request_key,creation_payload_fingerprint,git_remote_url,git_repository_key,progress_percent,progress_summary)
           values($1,$2,$3,$4,'approved',null,$5,$6::uuid,$7,$8,$9,
             case $4 when 'draft' then 10 when 'open' then 30 when 'active' then 65 when 'completed' then 100 when 'archived' then 0 end,
             case $4 when 'draft' then 'Project is in draft.' when 'open' then 'Project is open for delivery.' when 'active' then 'Project delivery is active.' when 'completed' then 'Project delivery is complete.' when 'archived' then 'Project is archived.' end)
           on conflict(creation_requested_by,creation_request_key) do nothing
           returning id,client_id,title,description,status,approval_status,git_remote_url,git_repository_key,created_at,updated_at,creation_payload_fingerprint`,
          [ownerId, title, description, status, session.id, creationRequestKey, payloadFingerprint, gitLink.remoteUrl, gitLink.repositoryKey],
        );

    if (inserted.rows[0] && engineerCreating) {
      const membershipResult = await client.query(
        `insert into project_memberships(project_id,user_id,membership_type,membership_status,is_project_proposal,created_by)
         values($1,$2,'creator','active',false,$2)
         returning id,project_id,user_id,membership_type,membership_status,is_project_proposal,created_by,created_at`,
        [inserted.rows[0].id, session.id],
      );
      if (membershipResult.rows.length !== 1) throw new ProjectServiceError('Project could not be created', 409, 'conflict');
    } else if (inserted.rows[0] && selectedEngineerIds.length) {
      const membershipResult = await client.query(
        `insert into project_memberships(project_id,user_id,membership_type,membership_status,is_project_proposal,created_by)
         select $1,u.id,'creator','active',false,$3 from app_users u
          where u.id=any($2::bigint[]) and u.account_type='engineer' and u.approval_status='approved'
         returning id,project_id,user_id,membership_type,membership_status,is_project_proposal,created_by,created_at`,
        [inserted.rows[0].id, selectedEngineerIds, session.id],
      );
      if (membershipResult.rows.length !== selectedEngineerIds.length) {
        throw new ProjectServiceError('Every selected engineer must be approved', 409, 'conflict');
      }
    }

    // ON CONFLICT waits for a concurrent creator transaction. Bind the key to the
    // canonical payload before returning any replayed project or memberships.
    const canonicalResult = await client.query(
      `select p.id,p.client_id,p.title,p.description,p.status,p.approval_status,p.proposal_kind,p.git_remote_url,p.git_repository_key,p.created_at,p.updated_at,p.creation_payload_fingerprint
         from projects p
        where p.creation_requested_by=$1 and p.creation_request_key=$2::uuid`,
      [session.id, creationRequestKey],
    );
    const project = canonicalResult.rows[0];
    if (!project) throw new ProjectServiceError('Project could not be created', 409, 'conflict');
    if (project.creation_payload_fingerprint !== payloadFingerprint) {
      throw new ProjectServiceError('Project creation key was already used for different inputs', 409, 'conflict');
    }

    let memberships: Record<string, unknown>[] = [];
    if (counterpartIds.length) {
      const membershipResult = await client.query(
        `select id,project_id,user_id,membership_type,membership_status,is_project_proposal,created_by,created_at
           from project_memberships
          where project_id=$1 and user_id=any($2::bigint[])
          order by user_id asc`,
        [project.id, counterpartIds],
      );
      memberships = membershipResult.rows;
      const canonicalIds = memberships.map((membership) => String(membership.user_id)).sort((left, right) => {
        const leftId = BigInt(left);
        const rightId = BigInt(right);
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      });
      if (
        canonicalIds.length !== counterpartIds.length
        || canonicalIds.some((memberId, index) => memberId !== counterpartIds[index])
        || memberships.some((membership) => membership.membership_type !== 'creator' || membership.membership_status !== 'active')
      ) {
        throw new ProjectServiceError('Project counterpart memberships are inconsistent', 409, 'conflict');
      }
    }
    if (inserted.rows[0]) {
      // Formation outputs are created only after every creator membership is active.
      // The creator actor id records provenance; these outputs are never uploads.
      const structured = await loadProjectAgentStructuredData(client, String(project.id));
      await ensureCanonicalProjectDocuments(
        client,
        project,
        structured.memberRoster,
        structured.projectStatistics,
        session.id,
      );
    }
    await client.query('commit');
    const { creation_payload_fingerprint: _fingerprint, ...publicProject } = project;
    const canonicalProject = { ...publicProject, memberships };
    return engineerCreating ? { ...canonicalProject, membership: memberships[0] } : canonicalProject;
  } catch (error) {
    if (transactionStarted) {
      try { await client.query('rollback'); } catch { /* Preserve the primary transaction failure. */ }
    }
    throw error;
  } finally {
    client.release();
  }
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
     where id=$1 and client_id=$2 and approval_status='approved'
     returning id,client_id,title,description,status,approval_status,created_at,updated_at`,
    [project, session.id, title, description, status],
  );
  if (!result.rows[0]) throw new ProjectServiceError('Project not found', 404, 'not_found');
  return result.rows[0];
}

/** Atomically fills the nullable legacy Git link. An established identity is immutable. */
export async function attachProjectGitRemote(session: SessionUser, projectId: unknown, gitRemote: unknown) {
  const project = id(projectId, 'project id');
  const platformAdmin = session.role === 'admin' && session.account_type === 'admin';
  if (!platformAdmin && session.account_type !== 'client') throw new ProjectServiceError('Forbidden', 403, 'forbidden');
  const db = await ready();
  const authorized = await db.query(
    `select id,client_id,git_remote_url,git_repository_key from projects
      where id=$1 and approval_status='approved' and ($2::boolean or client_id=$3)`,
    [project, platformAdmin, session.id],
  );
  const existing = authorized.rows[0];
  if (!existing) throw new ProjectServiceError('Project not found', 404, 'not_found');
  if (existing.git_remote_url !== null || existing.git_repository_key !== null) throw new ProjectServiceError('Project already has a Git remote', 409, 'git_remote_already_attached');
  let link: ReturnType<typeof parseGitRemote>;
  try { link = parseGitRemote(gitRemote); }
  catch { throw new ProjectServiceError('A valid credential-free Git remote is required'); }
  const result = await db.query(
    `update projects set git_remote_url=$2,git_repository_key=$3,updated_at=now()
      where id=$1 and git_remote_url is null and git_repository_key is null
      returning id,client_id,title,description,status,approval_status,git_remote_url,git_repository_key,created_at,updated_at`,
    [project, link.remoteUrl, link.repositoryKey],
  );
  if (!result.rows[0]) throw new ProjectServiceError('Project already has a Git remote', 409, 'git_remote_already_attached');
  return result.rows[0];
}

export async function listProjects(session: SessionUser, options: ProjectReadOptions = {}) {
  const db = await ready();
  if (options.platformAudit) {
    requirePlatformAdmin(session);
    return (await db.query(
      `select p.id,p.client_id,p.title,p.description,p.status,p.approval_status,p.git_remote_url,p.git_repository_key,p.created_at,p.updated_at
       from projects p order by p.updated_at desc,p.id desc`,
    )).rows;
  }
  if (session.account_type === 'engineer') {
    // Open projects are discoverable summaries. Pending and active membership state is
    // included so the UI can offer the correct action without granting workspace access.
    return (await db.query(
      `select p.id,p.client_id,p.title,p.description,p.status,p.approval_status,
              case when pm.membership_status='active' then p.git_remote_url else null end as git_remote_url,
              case when pm.membership_status='active' then p.git_repository_key else null end as git_repository_key,
              p.created_at,p.updated_at,
              pm.id as membership_id,pm.membership_type,pm.membership_status
       from projects p
       left join project_memberships pm on pm.project_id=p.id and pm.user_id=$1
       where (p.approval_status='approved' and p.status='open') or pm.user_id=$1
       order by p.updated_at desc,p.id desc`,
      [session.id],
    )).rows;
  }
  if (session.account_type === 'client') {
    return (await db.query(
      `select p.id,p.client_id,p.title,p.description,p.status,p.approval_status,p.git_remote_url,p.git_repository_key,p.created_at,p.updated_at,
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
      `select p.id,p.client_id,p.title,p.description,p.status,p.approval_status,p.git_remote_url,p.git_repository_key,p.created_at,p.updated_at from projects p where p.id=$1`,
      [id(projectId, 'project id')],
    );
    if (!auditResult.rows[0]) throw new ProjectServiceError('Project not found', 404, 'not_found');
    return auditResult.rows[0];
  }
  const access = projectAccessSql('$2');
  const result = await db.query(
    `select distinct p.id,p.client_id,p.title,p.description,p.status,p.approval_status,p.git_remote_url,p.git_repository_key,p.created_at,p.updated_at
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
    `insert into project_memberships(project_id,user_id,membership_type,membership_status,is_project_proposal,created_by)
     select p.id,u.id,'invitation','pending',false,$2
     from projects p join app_users u on u.id=$3 and u.account_type='engineer' and u.approval_status='approved'
     where p.id=$1 and p.client_id=$2 and p.approval_status='approved'
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
    `insert into project_memberships(project_id,user_id,membership_type,membership_status,is_project_proposal,created_by)
     select p.id,$2,'request','pending',false,$2 from projects p
     where p.id=$1 and p.status='open' and p.approval_status='approved'
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
    `select pm.id,pm.project_id,pm.user_id,u.display_name,pm.membership_type,pm.membership_status,pm.created_at,pm.responded_at,
            coalesce(pm.is_project_proposal,false) as is_project_proposal
     from project_memberships pm join projects p on p.id=pm.project_id and p.client_id=$2
     join app_users u on u.id=pm.user_id where pm.project_id=$1 order by pm.created_at desc,pm.id desc`,
    [project, session.id],
  )).rows;
}

export async function respondToMembership(session: SessionUser, projectId: unknown, membershipId: unknown, action: unknown) {
  const project = id(projectId, 'project id');
  const membership = id(membershipId, 'membership id');
  const requestedAction = String(action ?? '');
  const engineerDecision = session.account_type === 'engineer' && ['accept', 'decline'].includes(requestedAction);
  const clientDecision = session.account_type === 'client' && ['approve', 'reject'].includes(requestedAction);
  if (!engineerDecision && !clientDecision) throw new ProjectServiceError('Invalid membership action');

  const pool = await ready();
  const client: PoolClient = await pool.connect();
  try {
    await client.query('begin');
    const locked = await client.query(
      `select pm.id,pm.project_id,pm.user_id,pm.membership_type,pm.membership_status,pm.created_by,pm.responded_by,pm.responded_at,
              p.client_id,p.status as project_status,p.approval_status
         from project_memberships pm join projects p on p.id=pm.project_id
        where pm.id=$2 and pm.project_id=$1
          and (($4='engineer' and pm.user_id=$3 and pm.membership_type='invitation')
            or ($4='client' and p.client_id=$3 and pm.membership_type='request'))
        for update of pm,p`,
      [project, membership, session.id, session.account_type],
    );
    const row = locked.rows[0];
    if (!row) throw new ProjectServiceError('Membership not found', 404, 'not_found');

    const targetStatus = requestedAction === 'accept' || requestedAction === 'approve' ? 'active'
      : requestedAction === 'decline' ? 'declined' : 'rejected';
    if (row.membership_status !== 'pending') {
      if (row.membership_status !== targetStatus) {
        throw new ProjectServiceError('Membership already received the opposite decision', 409, 'conflict');
      }

      await client.query('commit');
      return {
        id: row.id, project_id: row.project_id, user_id: row.user_id,
        membership_status: row.membership_status, responded_at: row.responded_at,
        approval_status: row.approval_status, project_status: row.project_status,
      };
    }

    const projectApproval = row.approval_status;
    const projectStatus = row.project_status;
    if (clientDecision && row.approval_status !== 'approved') {
      throw new ProjectServiceError('Membership request is not attached to an approved project', 409, 'conflict');
    }

    const updated = await client.query(
      `update project_memberships set membership_status=$3,responded_by=$4,responded_at=now()
        where id=$2 and project_id=$1 and membership_status='pending'
        returning id,project_id,user_id,membership_status,responded_at`,
      [project, membership, targetStatus, session.id],
    );
    if (!updated.rows[0]) throw new ProjectServiceError('Membership has already been decided', 409, 'conflict');
    await client.query('commit');
    return { ...updated.rows[0], approval_status: projectApproval, project_status: projectStatus };
  } catch (error) {
    try { await client.query('rollback'); } catch { /* Preserve the primary failure. */ }
    throw error;
  } finally {
    client.release();
  }
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
