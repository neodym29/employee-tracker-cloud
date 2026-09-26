import 'server-only';
import type { SessionUser } from './auth';
import { ensureSchema, getPool } from './db';
import { ProjectServiceError, projectAccessSql } from './projects';
import { safeGitWorkText } from './tracemini-work-evidence';
import { humanizeCommitSubject } from './git-subject';

const ENGINEER_LIMIT = 20;
const UPDATE_LIMIT = 3;
const EVENT_LIMIT = 240;

export type EngineerUpdate = {
  id: string;
  projectId: string;
  projectTitle: string;
  summary: string;
  occurredAt: string;
  importedHistory: boolean;
};

export type EngineerUpdateGroup = {
  id: string;
  name: string;
  projects: Array<{ id: string; title: string }>;
  updates: EngineerUpdate[];
};

function timestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function safeName(value: unknown) {
  return safeGitWorkText(value, 120) || 'Project engineer';
}

function safeProjectTitle(value: unknown) {
  return safeGitWorkText(value, 120) || 'Project';
}

function updateSummary(row: Record<string, any>) {
  const provenance = row.provenance && typeof row.provenance === 'object' && !Array.isArray(row.provenance)
    ? row.provenance as Record<string, unknown> : {};
  if (row.kind === 'commit') return humanizeCommitSubject(provenance.commit_subject);
  if (row.kind === 'file_change' || row.kind === 'file_activity' || row.kind === 'dirty' || row.kind === 'non_git') {
    const changed = Number(provenance.files_changed);
    return Number.isSafeInteger(changed) && changed > 0
      ? `Changed ${changed} file${changed === 1 ? '' : 's'} in the working project.`
      : 'Recorded work in the project files.';
  }
  if (row.kind === 'merge') return 'Merged recent project work.';
  if (row.kind === 'push') return 'Published recent repository changes.';
  if (row.kind === 'pull') return 'Updated the local project with shared changes.';
  if (row.kind === 'rewrite') return 'Updated the project’s recorded history.';
  if (row.kind === 'stage') return 'Prepared project changes for a commit.';
  if (row.kind === 'branch') return 'Changed the active line of project work.';
  return 'Recorded new project activity.';
}

function projectFilter(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const project = String(value);
  if (!/^[1-9]\d*$/.test(project)) throw new ProjectServiceError('Invalid project id');
  return project;
}

/** Client-only, access-scoped activity grouped by the engineer whose approved
 * Neo-Nexus device recorded it. Imported history is labelled separately in the UI. */
export async function listClientEngineerUpdates(session: SessionUser, projectValue?: unknown): Promise<EngineerUpdateGroup[]> {
  if (session.account_type !== 'client') throw new ProjectServiceError('Forbidden', 403, 'forbidden');
  const project = projectFilter(projectValue);
  await ensureSchema();
  const db = getPool();
  const access = projectAccessSql('$1');
  const memberships = (await db.query(
    `select distinct engineer.id as engineer_id,engineer.display_name,p.id as project_id,p.title as project_title
       from projects p
       ${access.join}
       join project_memberships assigned on assigned.project_id=p.id and assigned.membership_status='active'
       join app_users engineer on engineer.id=assigned.user_id and engineer.company_id=$3 and engineer.account_type='engineer' and engineer.approval_status='approved'
      where ${access.predicate} and p.status<>'archived' and ($2::bigint is null or p.id=$2)
      order by engineer.display_name,engineer.id,p.title,p.id`,
    [session.id, project, session.company_id],
  )).rows;

  if (!memberships.length) return [];
  const events = (await db.query(
    `select e.id,e.kind,e.action,e.occurred_at,e.provenance,p.id as project_id,p.title as project_title,
            engineer.id as engineer_id,engineer.display_name
       from project_tracemini_events e
       join projects p on p.id=e.project_id and p.status<>'archived' and p.approval_status='approved'
       ${access.join}
       join files_agent_devices device on device.id=e.device_id and device.revoked_at is null
       join app_users engineer on engineer.id=device.user_id and engineer.company_id=$3 and engineer.account_type='engineer' and engineer.approval_status='approved'
       join project_memberships assigned on assigned.project_id=p.id and assigned.user_id=engineer.id and assigned.membership_status='active'
       join project_tracemini_roots root on root.id=e.root_id and root.project_id=p.id and root.device_id=device.id
      where ${access.predicate} and ($2::bigint is null or p.id=$2)
        and e.kind in ('commit','file_change','file_activity','non_git','dirty','merge','rewrite')
      order by e.occurred_at desc,e.id desc limit ${EVENT_LIMIT}`,
    [session.id, project, session.company_id],
  )).rows;

  const groups = new Map<string, EngineerUpdateGroup>();
  for (const membership of memberships) {
    const engineerId = String(membership.engineer_id);
    let group = groups.get(engineerId);
    if (!group) {
      if (groups.size >= ENGINEER_LIMIT) continue;
      group = { id: engineerId, name: safeName(membership.display_name), projects: [], updates: [] };
      groups.set(engineerId, group);
    }
    const projectId = String(membership.project_id);
    if (!group.projects.some((candidate) => candidate.id === projectId)) {
      group.projects.push({ id: projectId, title: safeProjectTitle(membership.project_title) });
    }
  }

  const seen = new Set<string>();
  for (const row of events) {
    const group = groups.get(String(row.engineer_id));
    if (!group || group.updates.length >= UPDATE_LIMIT) continue;
    const provenance = row.provenance && typeof row.provenance === 'object' && !Array.isArray(row.provenance)
      ? row.provenance as Record<string, unknown> : {};
    const sha = typeof provenance.head_sha === 'string' ? provenance.head_sha : '';
    const dedupe = sha ? `${row.project_id}:${row.engineer_id}:${sha}` : `event:${row.id}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    group.updates.push({
      id: String(row.id),
      projectId: String(row.project_id),
      projectTitle: safeProjectTitle(row.project_title),
      summary: updateSummary(row),
      occurredAt: timestamp(row.occurred_at),
      importedHistory: row.action === 'commit_history',
    });
  }
  return [...groups.values()];
}
