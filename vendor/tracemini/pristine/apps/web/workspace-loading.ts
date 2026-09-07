import {getRouteContext, getRouteView} from './routes.js';

export type WorkspaceLoadKey = 'dashboard' | 'settings' | 'reports' | 'agents' | 'report';
export type WorkspaceLoadItem = {key: WorkspaceLoadKey; path: string};

export function workspaceLoadPlan(
  route: string,
  workspaceId: number,
  dates: {from: string; to: string},
  timezone?: string,
  repositoryIds?: number[] | null,
): WorkspaceLoadItem[] {
  if (!workspaceId) return [];
  const view = getRouteView(route, workspaceId);
  const base = `/workspaces/${workspaceId}`;
  if (view === 'install') return [{key: 'agents', path: `${base}/agents`}];
  if (view === 'settings') return [{key: 'settings', path: `${base}/settings`}];
  if (view === 'reports') return [{key: 'reports', path: `${base}/reports`}];
  if (view === 'report') {
    const reportId = getRouteContext(route).reportId;
    return reportId ? [{key: 'report', path: `/reports/${reportId}`}] : [];
  }
  if (view !== 'dashboard') return [];

  const match = route.match(/^\/workspaces\/\d+\/(users|repositories)\/(\d+)/);
  const timezoneFilter = timezone ? `&timezone=${encodeURIComponent(timezone)}` : '';
  const routeScope = match && (match[1] === 'users' || repositoryIds == null)
    ? `&${match[1] === 'users' ? 'userId' : 'repositoryId'}=${match[2]}`
    : '';
  const repositoryFilter = repositoryIds == null ? '' : `&repositoryIds=${repositoryIds.join(',')}`;
  return [{key: 'dashboard', path: `${base}/dashboard?from=${dates.from}&to=${dates.to}${timezoneFilter}${routeScope}${repositoryFilter}`}];
}
