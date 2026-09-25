import 'server-only';
import type { SessionUser } from './auth';
import { ensureSchema, getPool } from './db';
import { ProjectServiceError, projectAccessSql } from './projects';
import { humanizeCommitSubject } from './git-subject';

export const CLIENT_PRIORITY_LIMIT = 3;
export const CLIENT_PRIORITY_MAX = 160;
export const PROGRESS_SUMMARY_MAX = 240;
const TIMELINE_LIMIT = 8;
const TIMELINE_LABEL_MAX = 320;
const RECENT_CHANGE_LIMIT = 3;
const RECENT_CHANGE_MAX = 600;

type ProjectStatus = 'draft' | 'open' | 'active' | 'completed' | 'archived';
type TimelineItem = { id: string; label: string; createdAt: string };

export type ProjectOverview = {
  project: { id: string; title: string; description: string; status: ProjectStatus; gitRemote: string | null; deploymentUrl: string | null; createdAt: string; updatedAt: string };
  stage: { label: string; closed: boolean };
  progress: { percent: number | null; summary: string; version: number; updatedAt: string; source: 'unassessed' | 'manual' | 'plugin_daily' };
  assessment: {
    state: 'not_connected' | 'connecting' | 'reading_history' | 'assessing' | 'ready' | 'attention';
    label: string;
    detail: string;
    percent: number;
    repositoryName: string | null;
    repositoryConnected: boolean;
    historyRead: boolean;
    contextReady: boolean;
    commitsRead: number;
    eventsRead: number;
    deviceOnline: boolean;
    firstCommitAt: string;
    lastCommitAt: string;
    lastReceivedAt: string;
  };
  clientName: string;
  analytics: { activeEngineerCount: number; confirmedActionCount: number; pendingActionCount: number; totalChatCount: number };
  clientPriorities: Array<{ id: string; summary: string; createdAt: string }>;
  timeline: TimelineItem[];
  recentChanges: Array<{ id: string; summary: string; status: 'in_progress' | 'completed' | 'blocked'; createdAt: string }>;
  historicalChanges: Array<{ id: string; summary: string; createdAt: string; imported: boolean }>;
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
    `select p.id,p.title,p.description,p.status,p.git_remote_url,p.deployment_url,p.progress_percent,p.progress_summary,p.progress_version,p.progress_updated_at,p.progress_source,p.created_at,p.updated_at,
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
       ) timeline_row),'[]'::json) as timeline,
       coalesce((select json_agg(change_row order by change_row.created_at desc) from (
         select work.id,left(work.summary,${RECENT_CHANGE_MAX}) as summary,work.status,work.created_at
         from codex_plugin_work_updates work
         where work.project_id=p.id and ($3::boolean=false or work.user_id=$2)
         order by work.created_at desc,work.id desc limit ${RECENT_CHANGE_LIMIT}
       ) change_row),'[]'::json) as recent_changes
     from projects p
     join app_users client on client.id=p.client_id
     ${platformAdmin ? '' : access.join}
     where p.id=$1 and ${platformAdmin ? "p.approval_status='approved'" : access.predicate}
     limit 1`,
    [project, session.id, session.account_type === 'engineer'],
  );
  const row = result.rows[0];
  if (!row) throw new ProjectServiceError('Project not found', 404, 'not_found');
  // Repair historical plugin updates when a project was added after the work
  // was recorded. Require an exact repository identity and active engineer
  // membership; never guess from the text of a summary.
  const bindingsReady = (await db.query(`select to_regclass('public.codex_plugin_project_bindings') is not null as ready`)).rows[0]?.ready === true;
  const repaired = await db.query(`update codex_plugin_work_updates work set project_id=$1
    from project_memberships engineer_member, projects p, app_users engineer
    where p.id=$1 and p.status<>'archived' and engineer_member.project_id=p.id
      and engineer_member.user_id=work.user_id and engineer_member.membership_status='active'
      and engineer.id=work.user_id and engineer.company_id=work.company_id
      and engineer.account_type='engineer' and engineer.approval_status='approved'
      and work.project_id is null and work.repository_key is not null
      and (
        ${bindingsReady ? `exists(select 1 from codex_plugin_project_bindings binding
          where binding.project_id=p.id and binding.company_id=work.company_id
            and binding.user_id=work.user_id and binding.repository_key=work.repository_key)` : 'false'}
        or (p.git_repository_key=work.repository_key and not exists(
          select 1 from projects other join project_memberships other_member on other_member.project_id=other.id
          where other.id<>p.id and other.git_repository_key=work.repository_key
            and other.approval_status='approved' and other.status<>'archived'
            and other_member.user_id=work.user_id and other_member.membership_status='active'))
      ) returning work.id`, [project]);
  if (repaired.rowCount) {
    const recent = await db.query(`select id,left(summary,${RECENT_CHANGE_MAX}) as summary,status,created_at
      from codex_plugin_work_updates where project_id=$1 and ($2::boolean=false or user_id=$3)
      order by created_at desc,id desc limit ${RECENT_CHANGE_LIMIT}`, [project, session.account_type === 'engineer', session.id]);
    row.recent_changes = recent.rows;
  }
  const hasPluginChanges = jsonRows(row.recent_changes).length > 0;
  const historicalRows = hasPluginChanges ? [] : (await db.query(`select id,provenance->>'commit_subject' as subject,occurred_at,action
    from project_tracemini_events where project_id=$1 and kind='commit' and provenance ? 'commit_subject'
    order by occurred_at desc,id desc limit 8`, [project])).rows;
  const historicalChanges: ProjectOverview['historicalChanges'] = [];
  const seenSubjects = new Set<string>();
  for (const change of historicalRows) {
    const summary = humanizeCommitSubject(change.subject);
    if (seenSubjects.has(summary)) continue;
    seenSubjects.add(summary);
    historicalChanges.push({ id: String(change.id), summary, createdAt: timestamp(change.occurred_at), imported: change.action === 'commit_history' });
    if (historicalChanges.length >= RECENT_CHANGE_LIMIT) break;
  }
  const assessmentRow = (await db.query(`select
      (select count(*) from tracemini_repository_candidates c where c.matched_project_id=$1) as candidate_count,
      (select count(*) from tracemini_repository_candidates c join tracemini_repository_selections s on s.candidate_id=c.id and s.revision=c.revision where c.matched_project_id=$1 and s.desired_tracking=true) as selected_count,
      (select count(*) from tracemini_repository_candidates c join tracemini_repository_selections s on s.candidate_id=c.id and s.revision=c.revision where c.matched_project_id=$1 and s.desired_tracking=true and s.completed_at is not null and c.tracking_state='tracking') as tracking_count,
      (select count(*) from project_tracemini_roots r where r.project_id=$1 and r.status='approved' and r.revoked_at is null) as root_count,
      (select count(*) from project_tracemini_events e where e.project_id=$1) as event_count,
      (select count(*) from project_tracemini_events e where e.project_id=$1 and e.action='commit_history') as history_count,
      (select min(e.occurred_at) from project_tracemini_events e where e.project_id=$1 and e.action='commit_history') as first_commit_at,
      (select max(e.occurred_at) from project_tracemini_events e where e.project_id=$1 and e.action='commit_history') as last_commit_at,
      (select max(e.created_at) from project_tracemini_events e where e.project_id=$1) as last_received_at,
      (select c.display_name from tracemini_repository_candidates c where c.matched_project_id=$1 order by c.updated_at desc,c.id desc limit 1) as repository_name,
      exists(select 1 from tracemini_repository_candidates c join files_agent_devices d on d.id=c.device_id and d.revoked_at is null where c.matched_project_id=$1 and d.last_seen_at>now()-interval '2 minutes') as device_online,
      (select r.status from project_tracemini_reports r where r.project_id=$1 and r.dedupe_key like 'automatic-original:%' order by r.created_at desc,r.id desc limit 1) as latest_report_status`, [project])).rows[0] || {};
  const candidates = count(assessmentRow.candidate_count);
  const selected = count(assessmentRow.selected_count);
  const tracking = count(assessmentRow.tracking_count);
  const roots = count(assessmentRow.root_count);
  const eventsRead = count(assessmentRow.event_count);
  const commitsRead = count(assessmentRow.history_count);
  const deviceOnline = assessmentRow.device_online === true;
  const reportStatus = String(assessmentRow.latest_report_status || '');
  const repositoryConnected = roots > 0 && selected > 0;
  const historyRead = commitsRead > 0;
  const contextReady = reportStatus === 'completed';
  let assessment: ProjectOverview['assessment'];
  if (!candidates && !roots) assessment = { state:'not_connected', label:'Repository not connected', detail:'Add a scanned repository to begin reading its commit history.', percent:0 } as ProjectOverview['assessment'];
  else if (!repositoryConnected || !tracking) assessment = { state:'connecting', label:deviceOnline?'Connecting repository':'Waiting for Neo-Nexus device', detail:deviceOnline?'The repository selection is waiting for local confirmation.':'The engineer’s Neo-Nexus service must be online to confirm this repository.', percent:20 } as ProjectOverview['assessment'];
  else if (!eventsRead) assessment = { state:'reading_history', label:'Waiting for repository data', detail:deviceOnline?'Neo-Nexus is importing the repository’s reachable commits.':'History import is waiting for the engineer’s Neo-Nexus service.', percent:50 } as ProjectOverview['assessment'];
  else if (reportStatus === 'failed') assessment = { state:'attention', label:'Assessment needs attention', detail:'Commit history was received, but the project-context assessment failed. Keep Neo-Nexus online and retry from Neo-Nexus health.', percent:75 } as ProjectOverview['assessment'];
  else if (!contextReady) assessment = { state:'assessing', label:reportStatus === 'running'?'Assessing project context':deviceOnline?'Preparing project context':'Waiting for Neo-Nexus device', detail:`${commitsRead} historical commit${commitsRead===1?'':'s'} stored; the project summary has not completed.`, percent:82 } as ProjectOverview['assessment'];
  else assessment = { state:'ready', label:'Recorded activity summarized', detail:`${commitsRead} historical commit${commitsRead===1?'':'s'} stored and a work summary completed. Commit metadata alone cannot establish the product’s exact purpose or verify the local repository’s full history.`, percent:100 } as ProjectOverview['assessment'];
  Object.assign(assessment, {
    repositoryName: assessmentRow.repository_name ? boundedSafeText(assessmentRow.repository_name, 160) : null,
    repositoryConnected,
    historyRead,
    contextReady,
    commitsRead,
    eventsRead,
    deviceOnline,
    firstCommitAt: timestamp(assessmentRow.first_commit_at),
    lastCommitAt: timestamp(assessmentRow.last_commit_at),
    lastReceivedAt: timestamp(assessmentRow.last_received_at),
  });
  const status = String(row.status) as ProjectStatus;
  const percent = row.progress_percent == null ? NaN : Number(row.progress_percent);
  const version = Number(row.progress_version);
  const progressSource = row.progress_source === 'plugin_daily' ? 'plugin_daily' : Number.isInteger(percent) ? 'manual' : 'unassessed';
  return {
    project: { id: String(row.id), title: String(row.title ?? ''), description: String(row.description ?? ''), status, gitRemote: row.git_remote_url ? String(row.git_remote_url) : null, deploymentUrl: row.deployment_url ? String(row.deployment_url) : null, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) },
    stage: projectStage(status),
    progress: { percent: Number.isInteger(percent) && percent >= 0 && percent <= 100 ? percent : null, summary: boundedSafeText(row.progress_summary, PROGRESS_SUMMARY_MAX), version: Number.isSafeInteger(version) && version > 0 ? version : 1, updatedAt: timestamp(row.progress_updated_at), source: progressSource },
    assessment,
    clientName: String(row.client_name ?? ''),
    analytics: { activeEngineerCount: count(row.active_engineer_count), confirmedActionCount: count(row.confirmed_action_count), pendingActionCount: count(row.pending_action_count), totalChatCount: count(row.total_chat_count) },
    clientPriorities: jsonRows(row.client_priorities).slice(0, CLIENT_PRIORITY_LIMIT).map((priority) => ({ id: String(priority.id), summary: boundedSafeText(priority.summary, CLIENT_PRIORITY_MAX), createdAt: timestamp(priority.created_at) })),
    timeline: jsonRows(row.timeline).slice(0, TIMELINE_LIMIT).map((item) => ({ id: String(item.id), label: boundedSafeText(item.label, TIMELINE_LABEL_MAX), createdAt: timestamp(item.created_at) })),
    recentChanges: jsonRows(row.recent_changes).slice(0, RECENT_CHANGE_LIMIT).flatMap((change) => {
      const summary = boundedSafeText(change.summary, RECENT_CHANGE_MAX);
      const createdAt = timestamp(change.created_at);
      if (!summary || !createdAt) return [];
      const status = change.status === 'completed' || change.status === 'blocked' ? change.status : 'in_progress';
      return [{ id: String(change.id), summary, status, createdAt }];
    }),
    historicalChanges,
  };
}
