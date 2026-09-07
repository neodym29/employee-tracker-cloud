export type CliDevice = {
  id: number;
  user_id: number;
  machine_name: string;
  status: 'online' | 'offline' | 'revoked';
  revoked_at: string | null;
};

export type CliConnectionState = 'connected' | 'offline' | 'not-detected';

export function deviceManagementAction(device: Pick<CliDevice, 'id' | 'status'>, workspaceId: number) {
  return device.status === 'revoked'
    ? {label: 'Remove', method: 'DELETE', path: `/workspaces/${workspaceId}/agents/${device.id}`}
    : {label: 'Revoke', method: 'POST', path: `/workspaces/${workspaceId}/agents/${device.id}/revoke`};
}

export async function checkCliConnection(
  workspaceId: number,
  userId: number,
  loadAgents: (path: string) => Promise<CliDevice[]>,
) {
  const agents = await loadAgents(`/workspaces/${workspaceId}/agents`);
  const personalDevices = agents.filter(agent => agent.user_id === userId && !agent.revoked_at);
  const onlineDevices = personalDevices.filter(agent => agent.status === 'online');
  return {
    agents,
    state: onlineDevices.length ? 'connected' as const : personalDevices.length ? 'offline' as const : 'not-detected' as const,
    machineNames: (onlineDevices.length ? onlineDevices : personalDevices).map(agent => agent.machine_name),
  };
}
