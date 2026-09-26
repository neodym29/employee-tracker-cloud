import 'server-only';

import type { SessionUser } from './auth';
import { ensureSchema, getPool } from './db';
import { ProjectServiceError, projectAccessSql } from './projects';

export type ClientRequestKind = 'task' | 'issue';
export type ClientRequestStatus = 'open' | 'in_progress' | 'resolved';
export type ClientRequestUpdateSource = 'web' | 'codex_plugin';

function positiveId(value: unknown, field: string) {
  const normalized = String(value ?? '');
  if (!/^[1-9]\d*$/.test(normalized)) throw new ProjectServiceError(`Invalid ${field}`);
  return normalized;
}

async function ready() {
  await ensureSchema();
  return getPool();
}

export async function listClientRequests(session: SessionUser, projectId: unknown) {
  const project = positiveId(projectId, 'project id');
  if (session.account_type === 'admin') throw new ProjectServiceError('Forbidden', 403, 'forbidden');
  const db = await ready();
  const access = projectAccessSql('$2');
  const result = await db.query(
    `select request.id,request.project_id,request.summary,request.details,
            request.request_kind as kind,request.status,request.created_at,request.updated_at,
            request.resolved_at,resolver.display_name as resolved_by,
            activity.last_updated_by,activity.last_updated_via,activity.last_status_changed_at,
            case when $3='engineer' then notification.read_at is null else false end as unread
       from project_client_request_summaries request
       join projects p on p.id=request.project_id
       ${access.join}
       left join project_request_notifications notification
         on notification.request_id=request.id and notification.user_id=$2
       left join app_users resolver on resolver.id=request.resolved_by
       left join lateral (
         select actor.display_name as last_updated_by,audit.details->>'source' as last_updated_via,
                audit.created_at as last_status_changed_at
           from tracemini_audit_log audit
           join app_users actor on actor.id=audit.actor_user_id
          where audit.project_id=request.project_id
            and audit.action='client_request_status_changed'
            and audit.details->>'requestId'=request.id::text
          order by audit.created_at desc,audit.id desc limit 1
       ) activity on true
      where request.project_id=$1 and ${access.predicate}
      order by (request.status='resolved'),request.updated_at desc,request.id desc
      limit 100`,
    [project, session.id, session.account_type],
  );
  return result.rows;
}

export async function markClientRequestsRead(session: SessionUser, projectId: unknown) {
  if (session.account_type !== 'engineer') throw new ProjectServiceError('Forbidden', 403, 'forbidden');
  const project = positiveId(projectId, 'project id');
  const db = await ready();
  const result = await db.query(
    `update project_request_notifications notification set read_at=coalesce(notification.read_at,now())
      from project_client_request_summaries request
      join project_memberships membership on membership.project_id=request.project_id
       and membership.user_id=$2 and membership.membership_status='active'
     where notification.request_id=request.id and notification.user_id=$2
       and request.project_id=$1 and notification.read_at is null
     returning notification.request_id`,
    [project, session.id],
  );
  return { markedRead: result.rowCount ?? result.rows.length };
}

export async function updateClientRequest(
  session: SessionUser,
  projectId: unknown,
  requestId: unknown,
  statusValue: unknown,
  auditContext: { source?: ClientRequestUpdateSource; deviceId?: unknown } = {},
) {
  if (session.account_type !== 'engineer') throw new ProjectServiceError('Forbidden', 403, 'forbidden');
  const project = positiveId(projectId, 'project id');
  const request = positiveId(requestId, 'request id');
  const status = String(statusValue ?? '') as ClientRequestStatus;
  if (!['open', 'in_progress', 'resolved'].includes(status)) throw new ProjectServiceError('Invalid request status');
  const source: ClientRequestUpdateSource = auditContext.source === 'codex_plugin' ? 'codex_plugin' : 'web';
  const deviceId = source === 'codex_plugin' ? positiveId(auditContext.deviceId, 'device id') : null;
  const pool = await ready();
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query(
      `update project_client_request_summaries request set
          status=$4,updated_at=now(),
          resolved_at=case when $4='resolved' then now() else null end,
          resolved_by=case when $4='resolved' then $2::bigint else null end
        where request.id=$3 and request.project_id=$1 and exists(
          select 1 from project_memberships membership
          where membership.project_id=request.project_id and membership.user_id=$2
            and membership.membership_status='active'
        )
        returning request.id,request.project_id,request.summary,request.details,
          request.request_kind as kind,request.status,request.created_at,request.updated_at,request.resolved_at`,
      [project, session.id, request, status],
    );
    if (!result.rows[0]) throw new ProjectServiceError('Client request not found', 404, 'not_found');
    if (status === 'resolved') {
      await client.query(
        `update project_request_notifications set read_at=coalesce(read_at,now()) where request_id=$1`,
        [request],
      );
    } else {
      await client.query(
        `update project_request_notifications set read_at=coalesce(read_at,now()) where request_id=$1 and user_id=$2`,
        [request, session.id],
      );
    }
    await client.query(
      `insert into tracemini_audit_log(project_id,actor_user_id,action,details)
       values($1,$2,'client_request_status_changed',$3::jsonb)`,
      [project, session.id, JSON.stringify({ requestId: request, status, source, ...(deviceId ? { deviceId } : {}) })],
    );
    await client.query('commit');
    return result.rows[0];
  } catch (error) {
    try { await client.query('rollback'); } catch { /* Preserve the primary failure. */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function unreadClientRequestCount(session: SessionUser) {
  if (session.account_type !== 'engineer') return 0;
  const db = await ready();
  const result = await db.query(
    `select count(*)::int as unread
       from project_request_notifications notification
       join project_client_request_summaries request on request.id=notification.request_id and request.status<>'resolved'
       join project_memberships membership on membership.project_id=request.project_id
        and membership.user_id=$1 and membership.membership_status='active'
      where notification.user_id=$1 and notification.read_at is null`,
    [session.id],
  );
  const count = Number(result.rows[0]?.unread ?? 0);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

export async function recentUnreadClientRequests(session: SessionUser) {
  if (session.account_type !== 'engineer') return { total: 0, requests: [] };
  const db = await ready();
  const result = await db.query(
    `select request.id,request.project_id,request.summary,notification.created_at,
            count(*) over ()::int as total_unread
       from project_request_notifications notification
       join project_client_request_summaries request on request.id=notification.request_id and request.status<>'resolved'
       join project_memberships membership on membership.project_id=request.project_id
        and membership.user_id=$1 and membership.membership_status='active'
      where notification.user_id=$1 and notification.read_at is null
      order by notification.created_at desc,request.id desc limit 20`,
    [session.id],
  );
  return { total: Number(result.rows[0]?.total_unread || 0), requests: result.rows.map(row => ({
    id: String(row.id), projectId: String(row.project_id), summary: String(row.summary), createdAt: row.created_at,
  })) };
}
