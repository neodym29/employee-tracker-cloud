import 'server-only';

import type { SessionUser } from './auth';
import { getPool } from './db';

export type ProjectDashboardProject = {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
};

export type ProjectDashboardFileChange = {
  id: string;
  projectId: string;
  projectTitle: string;
  actionType: 'create_file' | 'update_file' | 'rename_file' | 'delete_file';
  confirmedAt: string;
};

export type ProjectDashboardData = {
  stats: {
    projects: number;
    activeProjects: number;
    confirmedChanges: number;
  };
  projects: ProjectDashboardProject[];
  fileChanges: ProjectDashboardFileChange[];
};

const FILE_ACTIONS = "('create_file','update_file','rename_file','delete_file')";

function roleScope(session: SessionUser) {
  if (session.account_type === 'client') {
    return {
      join: '',
      predicate: "p.approval_status='approved' and p.client_id=$1",
    };
  }
  if (session.account_type === 'engineer') {
    return {
      join: "join project_memberships pm on pm.project_id=p.id and pm.user_id=$1 and pm.membership_status='active'",
      predicate: "p.approval_status='approved'",
    };
  }
  throw new Error('project dashboard is available only to client and engineer accounts');
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function readProjectDashboard(session: SessionUser): Promise<ProjectDashboardData> {
  if (!/^\d+$/.test(session.id)) throw new Error('user id must be numeric');
  const scope = roleScope(session);
  const db = getPool();
  const [statsResult, projectsResult, changesResult] = await Promise.all([
    db.query(
      `select count(distinct p.id)::int as projects,
              count(distinct p.id) filter (where p.status in ('open','active'))::int as active_projects,
              count(a.id)::int as confirmed_changes
         from projects p
         ${scope.join}
         left join project_agent_actions a on a.project_id=p.id
          and a.status='confirmed' and a.confirmed_at is not null
          and a.action_type in ${FILE_ACTIONS}
        where ${scope.predicate}`,
      [session.id],
    ),
    db.query(
      `select p.id,p.title,p.status,p.updated_at
         from projects p
         ${scope.join}
        where ${scope.predicate}
        order by p.updated_at desc,p.id desc
        limit 6`,
      [session.id],
    ),
    db.query(
      `select a.id,p.id as project_id,p.title as project_title,a.action_type,a.confirmed_at
         from project_agent_actions a
         join projects p on p.id=a.project_id
         ${scope.join}
        where ${scope.predicate}
          and a.status='confirmed' and a.confirmed_at is not null
          and a.action_type in ${FILE_ACTIONS}
        order by a.confirmed_at desc,a.id desc
        limit 10`,
      [session.id],
    ),
  ]);

  const stats = statsResult.rows[0] ?? {};
  return {
    stats: {
      projects: count(stats.projects),
      activeProjects: count(stats.active_projects),
      confirmedChanges: count(stats.confirmed_changes),
    },
    projects: projectsResult.rows.map((row) => ({
      id: String(row.id),
      title: String(row.title),
      status: String(row.status),
      updatedAt: new Date(row.updated_at).toISOString(),
    })),
    fileChanges: changesResult.rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      projectTitle: String(row.project_title),
      actionType: String(row.action_type) as ProjectDashboardFileChange['actionType'],
      confirmedAt: new Date(row.confirmed_at).toISOString(),
    })),
  };
}
