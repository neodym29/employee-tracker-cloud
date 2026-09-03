import 'server-only';
import type { SessionUser } from './auth';
import { ensureSchema, getPool } from './db';
import { ProjectServiceError, projectAccessSql } from './projects';

export const CLIENT_PRIORITY_LIMIT = 3;
export const CLIENT_PRIORITY_MAX = 160;
export const PROGRESS_SUMMARY_MAX = 240;
const TIMELINE_LIMIT = 8;
const TIMELINE_LABEL_MAX = 320;

type ProjectStatus = 'draft' | 'open' | 'active' | 'completed' | 'archived';
type TimelineItem = { id: string; label: string; createdAt: string };

export type ProjectOverview = {
  project: { id: string; title: string; description: string; status: ProjectStatus; gitRemote: string | null; createdAt: string; updatedAt: string };
  stage: { label: string; closed: boolean };
  progress: { percent: number; summary: string; version: number; updatedAt: string };
  clientName: string;
  analytics: { activeEngineerCount: number; confirmedActionCount: number; pendingActionCount: number; totalChatCount: number };
  clientPriorities: Array<{ id: string; summary: string; createdAt: string }>;
  timeline: TimelineItem[];
};

export function projectStage(status: string) {
  if (status === 'draft') return { label: 'Draft', closed: false };
  if (status === 'open') return { label: 'Open', closed: false };
  if (status === 'active') return { label: 'Active', closed: false };
  if (status === 'completed') return { label: 'Completed', closed: true };
  return { label: 'Archived', closed: true };
}

function count(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function timestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function boundedSafeText(value: unknown, limit: number) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
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
  const platformAdmin = session.role === 'admin' && session.account_type === 'admin';
  const access = projectAccessSql('$2');
  const result = await db.query(
    `select p.id,p.title,p.description,p.status,p.git_remote_url,p.progress_percent,p.progress_summary,p.progress_version,p.progress_updated_at,p.created_at,p.updated_at,
       client.display_name as client_name,
       (select count(*) from project_memberships engineer_members
         join app_users engineer on engineer.id=engineer_members.user_id and engineer.account_type='engineer'
         where engineer_members.project_id=p.id and engineer_members.membership_status='active') as active_engineer_count,
       (select count(*) from project_agent_actions confirmed_actions where confirmed_actions.project_id=p.id and confirmed_actions.status='confirmed') as confirmed_action_count,
       (select count(*) from project_agent_actions pending_actions where pending_actions.project_id=p.id and pending_actions.actor_user_id=$2 and pending_actions.status='pending') as pending_action_count,
       (select count(*) from project_chat_messages all_chat where all_chat.project_id=p.id and all_chat.user_id=$2 and all_chat.role in ('user','assistant')) as total_chat_count,
       coalesce((select json_agg(priority_row order by priority_row.created_at desc) from (
         select priority.id,priority.summary,priority.created_at
         from project_client_request_summaries priority
         where priority.project_id=p.id
         order by priority.created_at desc,priority.id desc limit ${CLIENT_PRIORITY_LIMIT}
       ) priority_row),'[]'::json) as client_priorities,
       coalesce((select json_agg(timeline_row order by timeline_row.created_at desc) from (
         select event.id,left(regexp_replace(event.label,'[[:cntrl:]]',' ','g'),${TIMELINE_LABEL_MAX}) as label,event.created_at from (
           select 'action:' || action.id as id,
             case action.action_type
               when 'create_file' then 'Created ' || left(coalesce(action.result->>'path','project output'),180) || ' at version ' || coalesce(action.result->>'version','1')
               when 'update_file' then 'Updated ' || left(coalesce(action.result->>'path','project output'),180) || ' to version ' || coalesce(action.result->>'version','?')
               when 'rename_file' then 'Renamed output to ' || left(coalesce(action.result->>'path','project output'),180) || ' at version ' || coalesce(action.result->>'version','?')
               when 'delete_file' then 'Removed ' || left(coalesce(action.result->>'path','project output'),180) || ' at version ' || coalesce(action.result->>'version','?')
               when 'update_project_progress' then 'Progress changed from ' || coalesce(action.result->>'fromPercent','?') || '% to ' || coalesce(action.result->>'toPercent','?') || '%: ' || left(coalesce(action.result->>'toSummary',''),240)
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
     ${platformAdmin ? '' : access.join}
     where p.id=$1 and ${platformAdmin ? "p.approval_status='approved'" : access.predicate}
     limit 1`,
    [project, session.id],
  );
  const row = result.rows[0];
  if (!row) throw new ProjectServiceError('Project not found', 404, 'not_found');
  const status = String(row.status) as ProjectStatus;
  const percent = Number(row.progress_percent);
  const version = Number(row.progress_version);
  return {
    project: { id: String(row.id), title: String(row.title ?? ''), description: String(row.description ?? ''), status, gitRemote: row.git_remote_url ? String(row.git_remote_url) : null, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) },
    stage: projectStage(status),
    progress: { percent: Number.isInteger(percent) && percent >= 0 && percent <= 100 ? percent : 0, summary: boundedSafeText(row.progress_summary, PROGRESS_SUMMARY_MAX), version: Number.isSafeInteger(version) && version > 0 ? version : 1, updatedAt: timestamp(row.progress_updated_at) },
    clientName: String(row.client_name ?? ''),
    analytics: { activeEngineerCount: count(row.active_engineer_count), confirmedActionCount: count(row.confirmed_action_count), pendingActionCount: count(row.pending_action_count), totalChatCount: count(row.total_chat_count) },
    clientPriorities: jsonRows(row.client_priorities).slice(0, CLIENT_PRIORITY_LIMIT).map((priority) => ({ id: String(priority.id), summary: boundedSafeText(priority.summary, CLIENT_PRIORITY_MAX), createdAt: timestamp(priority.created_at) })),
    timeline: jsonRows(row.timeline).slice(0, TIMELINE_LIMIT).map((item) => ({ id: String(item.id), label: boundedSafeText(item.label, TIMELINE_LABEL_MAX), createdAt: timestamp(item.created_at) })),
  };
}
