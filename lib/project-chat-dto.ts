export type PublicAgentAction = {
  id: string;
  action_type: 'create_file' | 'update_file' | 'rename_file' | 'delete_file';
  status: 'pending' | 'confirmed' | 'cancelled';
  created_at: string;
};

const ACTION_TYPES = new Set<PublicAgentAction['action_type']>(['create_file', 'update_file', 'rename_file', 'delete_file']);
const ACTION_STATUSES = new Set<PublicAgentAction['status']>(['pending', 'confirmed', 'cancelled']);

export function toPublicAgentAction(value: unknown): PublicAgentAction {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid project agent action');
  const row = value as Record<string, unknown>;
  const actionType = String(row.action_type ?? '') as PublicAgentAction['action_type'];
  const status = String(row.status ?? '') as PublicAgentAction['status'];
  const date = new Date(String(row.created_at ?? ''));
  if (!ACTION_TYPES.has(actionType) || !ACTION_STATUSES.has(status) || Number.isNaN(date.getTime())) throw new TypeError('Invalid project agent action');
  return { id: String(row.id ?? ''), action_type: actionType, status, created_at: date.toISOString() };
}
