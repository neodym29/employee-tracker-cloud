import {describe, expect, it} from 'vitest';
import {checkCliConnection, deviceManagementAction} from '../apps/web/device-connection.js';

describe('manual CLI connection check', () => {
  it('checks only the workspace agents endpoint and returns the current user connection state', async () => {
    const requested: string[] = [];
    const result = await checkCliConnection(8, 8, async path => {
      requested.push(path);
      return [
        {id: 15, user_id: 8, machine_name: 'murtaza', status: 'online', revoked_at: null},
        {id: 20, user_id: 9, machine_name: 'other', status: 'online', revoked_at: null},
      ];
    });

    expect(requested).toEqual(['/workspaces/8/agents']);
    expect(result.state).toBe('connected');
    expect(result.machineNames).toEqual(['murtaza']);
    expect(result.agents).toHaveLength(2);
  });
});

describe('device management actions', () => {
  it('offers website removal only after a device is revoked', () => {
    expect(deviceManagementAction({id: 7, status: 'online'}, 4)).toEqual({label: 'Revoke', method: 'POST', path: '/workspaces/4/agents/7/revoke'});
    expect(deviceManagementAction({id: 7, status: 'revoked'}, 4)).toEqual({label: 'Remove', method: 'DELETE', path: '/workspaces/4/agents/7'});
  });
});
