import {describe, expect, it} from 'vitest';
import {workspaceLoadPlan} from '../apps/web/workspace-loading.js';

const dates = {from: '2026-08-01', to: '2026-08-25'};

describe('route-specific workspace loading', () => {
  it('loads only device state on the install route', () => {
    expect(workspaceLoadPlan('/workspaces/8/install', 8, dates)).toEqual([
      {key: 'agents', path: '/workspaces/8/agents'},
    ]);
  });

  it('loads only report data on report routes', () => {
    expect(workspaceLoadPlan('/workspaces/8/reports', 8, dates)).toEqual([
      {key: 'reports', path: '/workspaces/8/reports'},
    ]);
    expect(workspaceLoadPlan('/workspaces/8/reports/11', 8, dates)).toEqual([
      {key: 'report', path: '/reports/11'},
    ]);
  });

  it('loads only settings data on the settings route', () => {
    expect(workspaceLoadPlan('/workspaces/8/settings', 8, dates)).toEqual([
      {key: 'settings', path: '/workspaces/8/settings'},
    ]);
  });

  it('loads only activity data on dashboard routes', () => {
    expect(workspaceLoadPlan('/workspaces/8', 8, dates)).toEqual([
      {key: 'dashboard', path: '/workspaces/8/dashboard?from=2026-08-01&to=2026-08-25'},
    ]);
    expect(workspaceLoadPlan('/workspaces/8/users/3', 8, dates)).toEqual([
      {key: 'dashboard', path: '/workspaces/8/dashboard?from=2026-08-01&to=2026-08-25&userId=3'},
    ]);
  });

  it('adds the selected timezone only to dashboard evidence requests', () => {
    expect(workspaceLoadPlan('/workspaces/8/users/3', 8, dates, 'Asia/Karachi')).toEqual([
      {key: 'dashboard', path: '/workspaces/8/dashboard?from=2026-08-01&to=2026-08-25&timezone=Asia%2FKarachi&userId=3'},
    ]);
  });

  it('loads dashboard evidence for multiple repositories, including an empty selection', () => {
    expect(workspaceLoadPlan('/workspaces/8', 8, dates, 'UTC', [2, 5])).toEqual([
      {key: 'dashboard', path: '/workspaces/8/dashboard?from=2026-08-01&to=2026-08-25&timezone=UTC&repositoryIds=2,5'},
    ]);
    expect(workspaceLoadPlan('/workspaces/8/repositories/2', 8, dates, 'UTC', [])).toEqual([
      {key: 'dashboard', path: '/workspaces/8/dashboard?from=2026-08-01&to=2026-08-25&timezone=UTC&repositoryIds='},
    ]);
  });
});
