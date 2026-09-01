export type PublicAgentAction = {
  id: string;
  action_type: 'create_file' | 'update_file' | 'rename_file' | 'delete_file' | 'update_project_progress';
  status: 'pending' | 'confirmed' | 'cancelled';
  description: string;
  created_at: string;
};

const DESCRIPTION_MAX = 320;
const ACTION_TYPES = new Set<PublicAgentAction['action_type']>(['create_file', 'update_file', 'rename_file', 'delete_file', 'update_project_progress']);
const ACTION_STATUSES = new Set<PublicAgentAction['status']>(['pending', 'confirmed', 'cancelled']);

function safeDescription(value: unknown) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX);
}

export function toPublicAgentAction(value: unknown): PublicAgentAction {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid project agent action');
  const row = value as Record<string, unknown>;
  const actionType = String(row.action_type ?? '') as PublicAgentAction['action_type'];
  const status = String(row.status ?? '') as PublicAgentAction['status'];
  const date = new Date(String(row.created_at ?? ''));
  if (!ACTION_TYPES.has(actionType) || !ACTION_STATUSES.has(status) || Number.isNaN(date.getTime())) throw new TypeError('Invalid project agent action');
  const supplied = safeDescription(row.description);
  const description = supplied || `${status === 'pending' ? 'Proposed' : status === 'confirmed' ? 'Confirmed' : 'Cancelled'} ${actionType === 'update_project_progress' ? 'project progress change' : 'project output change'}`;
  return { id: String(row.id ?? ''), action_type: actionType, status, description, created_at: date.toISOString() };
}
