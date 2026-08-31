import 'server-only';
import type { SessionUser } from './auth';
import { ensureSchema, getPool } from './db';
import { ProjectServiceError, projectAccessSql } from './projects';

export const CLIENT_REQUEST_LIMIT = 3;
export const CLIENT_REQUEST_BODY_MAX = 240;
const TIMELINE_LIMIT = 8;

type ProjectStatus = 'draft' | 'open' | 'active' | 'completed' | 'archived';
type TimelineItem = { id: string; label: string; createdAt: string };

export type ProjectOverview = {
  project: { id: string; title: string; description: string; status: ProjectStatus; createdAt: string; updatedAt: string };
  stage: { label: string; percent: number; closed: boolean };
  clientName: string;
  analytics: { activeEngineerCount: number; confirmedActionCount: number; pendingActionCount: number; totalChatCount: number };
  clientRequests: Array<{ id: string; body: string; createdAt: string }>;
  timeline: TimelineItem[];
};

export function projectStage(status: string) {
  if (status === 'draft') return { label: 'Draft', percent: 10, closed: false };
  if (status === 'open') return { label: 'Open', percent: 30, closed: false };
  if (status === 'active') return { label: 'Active', percent: 65, closed: false };
  if (status === 'completed') return { label: 'Completed', percent: 100, closed: true };
  return { label: 'Archived', percent: 0, closed: true };
}

function count(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function timestamp(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value ?? '');
}

function jsonRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

export async function getProjectOverview(session: SessionUser, projectId: unknown): Promise<ProjectOverview> {
  const project = String(projectId ?? '');
  if (!/^[1-9]\d*$/.test(project)) throw new ProjectServiceError('Invalid project id');
  await ensureSchema();
  const db = getPool();
  const access = projectAccessSql('$2');
  const result = await db.query(
    `select p.id,p.title,p.description,p.status,p.created_at,p.updated_at,
       client.display_name as client_name,
       (select count(*) from project_memberships engineer_members
         join app_users engineer on engineer.id=engineer_members.user_id and engineer.account_type='engineer'
         where engineer_members.project_id=p.id and engineer_members.membership_status='active') as active_engineer_count,
       (select count(*) from project_agent_actions confirmed_actions where confirmed_actions.project_id=p.id and confirmed_actions.status='confirmed') as confirmed_action_count,
       (select count(*) from project_agent_actions pending_actions where pending_actions.project_id=p.id and pending_actions.status='pending') as pending_action_count,
       (select count(*) from project_chat_messages all_chat where all_chat.project_id=p.id and all_chat.role in ('user','assistant')) as total_chat_count,
       coalesce((select json_agg(request_row order by request_row.created_at desc) from (
         select message.id,message.body,message.created_at
         from project_chat_messages message
         where message.project_id=p.id and message.user_id=p.client_id and message.role='user'
         order by message.created_at desc,message.id desc limit ${CLIENT_REQUEST_LIMIT}
       ) request_row),'[]'::json) as client_requests,
       coalesce((select json_agg(timeline_row order by timeline_row.created_at desc) from (
         select event.id,event.label,event.created_at from (
           select 'action:' || action.id as id,
             case action.action_type
               when 'create_file' then 'Created project output'
               when 'update_file' then 'Updated project output'
               when 'rename_file' then 'Renamed project output'
               when 'delete_file' then 'Removed project output'
               else 'Changed project output'
             end as label,
             coalesce(action.confirmed_at,action.created_at) as created_at
           from project_agent_actions action
           where action.project_id=p.id and action.status='confirmed'
           union all
           select 'project:' || p.id,'Project created',p.created_at
           union all
           select 'membership:' || member.id,'Project member became active',coalesce(member.responded_at,member.created_at)
           from project_memberships member where member.project_id=p.id and member.membership_status='active'
         ) event order by event.created_at desc limit ${TIMELINE_LIMIT}
       ) timeline_row),'[]'::json) as timeline
     from projects p
     join app_users client on client.id=p.client_id
     ${access.join}
     where p.id=$1 and ${access.predicate}
     limit 1`,
    [project, session.id],
  );
  const row = result.rows[0];
  if (!row) throw new ProjectServiceError('Project not found', 404, 'not_found');
  const status = String(row.status) as ProjectStatus;
  return {
    project: { id: String(row.id), title: String(row.title ?? ''), description: String(row.description ?? ''), status, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) },
    stage: projectStage(status),
    clientName: String(row.client_name ?? ''),
    analytics: { activeEngineerCount: count(row.active_engineer_count), confirmedActionCount: count(row.confirmed_action_count), pendingActionCount: count(row.pending_action_count), totalChatCount: count(row.total_chat_count) },
    clientRequests: jsonRows(row.client_requests).slice(0, CLIENT_REQUEST_LIMIT).map((request) => ({ id: String(request.id), body: String(request.body ?? '').trim().slice(0, CLIENT_REQUEST_BODY_MAX), createdAt: timestamp(request.created_at) })),
    timeline: jsonRows(row.timeline).slice(0, TIMELINE_LIMIT).map((item) => ({ id: String(item.id), label: String(item.label), createdAt: timestamp(item.created_at) })),
  };
}
