import 'server-only';

import type { SessionUser } from './auth';
import { ensureSchema, getPool } from './db';

export type ProjectDailySummary = {
  id: string;
  title: string;
  status: string;
  date: string;
  updates: Array<{
    id: string;
    summary: string;
    createdAt: string;
  }>;
};

export type EmployeeDailyDashboardData = {
  latestSummaryDate: string | null;
  projects: ProjectDailySummary[];
  otherWork: null | {
    date: string;
    updates: Array<{ id: string; summary: string; createdAt: string }>;
  };
};

function safeText(value: unknown, fallback: string, max = 16000) {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return (text || fallback).slice(0, max);
}

function iso(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function projectAccessPredicate(session: SessionUser) {
  if (session.account_type === 'admin') return 'true';
  if (session.account_type === 'client') return 'p.client_id=$1';
  return `exists (
    select 1 from project_memberships viewer_membership
     where viewer_membership.project_id=p.id
       and viewer_membership.user_id=$1
       and viewer_membership.membership_status='active'
  )`;
}

function projectWorkPredicate(session: SessionUser) {
  return session.account_type === 'engineer' ? 'work.user_id=$1' : 'true';
}

/** Latest durable Codex-plugin work day for every project visible to the signed-in
 * account. Project membership remains the authorization boundary. */
export async function readEmployeeDailyDashboard(session: SessionUser): Promise<EmployeeDailyDashboardData> {
  if (!/^[1-9]\d*$/.test(session.id) || !/^[1-9]\d*$/.test(session.company_id)) throw new Error('invalid session identity');
  await ensureSchema();
  const parameters = session.account_type === 'admin' ? [] : [session.id];
  const rows = (await getPool().query(
    `select p.id as project_id,p.title as project_title,p.status as project_status,
            latest_day.update_date::text,latest.updates
       from projects p
       join app_users project_owner on project_owner.id=p.client_id
         and project_owner.approval_status='approved'
       left join lateral (
         select work.update_date
           from codex_plugin_work_updates work
           join app_users engineer on engineer.id=work.user_id and engineer.company_id=work.company_id
             and engineer.account_type='engineer' and engineer.approval_status='approved'
           join project_memberships membership on membership.project_id=p.id
             and membership.user_id=engineer.id and membership.membership_status='active'
          where work.project_id=p.id
            and ${projectWorkPredicate(session)}
          order by work.update_date desc,work.created_at desc,work.id desc
          limit 1
       ) latest_day on true
       left join lateral (
         select jsonb_agg(jsonb_build_object(
                  'id',work.id::text,'summary',work.summary,
                  'createdAt',work.created_at
                ) order by work.created_at desc,work.id desc) as updates
           from codex_plugin_work_updates work
           join app_users engineer on engineer.id=work.user_id and engineer.company_id=work.company_id
             and engineer.account_type='engineer' and engineer.approval_status='approved'
           join project_memberships membership on membership.project_id=p.id
             and membership.user_id=engineer.id and membership.membership_status='active'
          where work.project_id=p.id
            and work.update_date=latest_day.update_date
            and ${projectWorkPredicate(session)}
       ) latest on latest_day.update_date is not null
      where p.approval_status='approved' and p.status<>'archived'
        and latest_day.update_date is not null
        and ${projectAccessPredicate(session)}
      order by latest_day.update_date desc,p.updated_at desc,p.id desc`,
    parameters,
  )).rows;

  let latestSummaryDate: string | null = null;
  const projects: ProjectDailySummary[] = [];
  for (const row of rows) {
    const summaryDate = String(row.update_date);
    if (!latestSummaryDate || summaryDate > latestSummaryDate) latestSummaryDate = summaryDate;
    const sourceUpdates = Array.isArray(row.updates) ? row.updates : [];
    const seen = new Set<string>();
    const updates = sourceUpdates.map((update: Record<string, unknown>) => ({
      id: safeText(update.id, 'update', 40),
      summary: safeText(update.summary, 'Codex recorded a project update.', 600),
      createdAt: iso(update.createdAt),
    })).filter((update: {summary:string}) => {
      const key = update.summary.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 20);
    if (!updates.length) continue;
    projects.push({
      id: String(row.project_id),
      title: safeText(row.project_title, 'Project', 120),
      status: safeText(row.project_status, 'active', 24),
      date: summaryDate,
      updates,
    });
  }

  let otherWork: EmployeeDailyDashboardData['otherWork'] = null;
  if (session.account_type === 'engineer') {
    const row = (await getPool().query(
      `select latest.update_date::text,jsonb_agg(jsonb_build_object(
                'id',work.id::text,'summary',work.summary,'createdAt',work.created_at
              ) order by work.created_at desc,work.id desc) as updates
         from (
           select max(update_date) as update_date
             from codex_plugin_work_updates
            where project_id is null and user_id=$1 and company_id=$2
         ) latest
         join codex_plugin_work_updates work on work.project_id is null
          and work.user_id=$1 and work.company_id=$2 and work.update_date=latest.update_date
        where latest.update_date is not null
        group by latest.update_date`,
      [session.id, session.company_id],
    )).rows[0];
    if (row?.update_date && Array.isArray(row.updates)) {
      const seen = new Set<string>();
      const updates = row.updates.map((update: Record<string, unknown>) => ({
        id: safeText(update.id, 'other-update', 40),
        summary: safeText(update.summary, 'Codex recorded other work.', 600),
        createdAt: iso(update.createdAt),
      })).filter((update: {summary:string}) => {
        const key = update.summary.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 30);
      if (updates.length) {
        otherWork = { date: String(row.update_date), updates };
        if (!latestSummaryDate || otherWork.date > latestSummaryDate) latestSummaryDate = otherWork.date;
      }
    }
  }

  return { latestSummaryDate, projects, otherWork };
}
