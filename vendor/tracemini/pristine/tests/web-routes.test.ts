import {describe, expect, it} from 'vitest';
import {getRouteContext, getRouteView, reportDuringLoad, reportMatchesRoute, workspacePath} from '../apps/web/routes.js';

describe('workspace route guards', () => {
  it('sends workspace-free users to a useful setup state instead of broken settings or install screens', () => {
    expect(getRouteView('/settings', 0)).toBe('workspace-required');
    expect(getRouteView('/install', 0)).toBe('workspace-required');
    expect(workspacePath(0, 'settings')).toBe('/settings');
    expect(workspacePath(0, 'install')).toBe('/install');
  });

  it('opens selected workspace settings, reports, and CLI installation from canonical workspace URLs', () => {
    expect(getRouteView('/settings', 4)).toBe('settings');
    expect(getRouteView('/workspaces/4/settings', 4)).toBe('settings');
    expect(getRouteView('/install', 4)).toBe('install');
    expect(getRouteView('/workspaces/4/install', 4)).toBe('install');
    expect(getRouteView('/workspaces/4/reports', 4)).toBe('reports');
    expect(workspacePath(4, 'settings')).toBe('/workspaces/4/settings');
    expect(workspacePath(4, 'install')).toBe('/workspaces/4/install');
    expect(workspacePath(4, 'reports')).toBe('/workspaces/4/reports');
  });

  it('keeps the displayed report mounted during background refreshes of the same route', () => {
    const report = {id: 12, workspace_id: 4};
    expect(reportDuringLoad(report, '/workspaces/4/reports/12')).toBe(report);
    expect(reportDuringLoad(report, '/workspaces/4/reports/13')).toBeUndefined();
    expect(reportDuringLoad(report, '/workspaces/4/reports')).toBeUndefined();
  });

  it('restores workspace and report identity from browser history routes', () => {
    expect(getRouteContext('/workspaces/4/reports/12')).toEqual({workspaceId: 4, reportId: 12});
    expect(getRouteContext('/workspaces/9/settings')).toEqual({workspaceId: 9});
    expect(reportMatchesRoute({id: 12, workspace_id: 4}, '/workspaces/4/reports/12')).toBe(true);
    expect(reportMatchesRoute({id: 12, workspace_id: 4}, '/workspaces/9/reports/12')).toBe(false);
    expect(reportMatchesRoute({id: 11, workspace_id: 4}, '/workspaces/4/reports/12')).toBe(false);
  });
});
