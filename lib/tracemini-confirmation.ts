const SAFE_STATUSES = new Set(['confirmed', 'unconfirmed', 'pending', 'required', 'not_required', 'approved', 'rejected']);

export function renderTraceMiniConfirmation(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? 'Confirmed' : 'Unconfirmed';
  if (typeof value === 'string' && SAFE_STATUSES.has(value)) return value === 'not_required' ? 'Not required' : `${value[0].toUpperCase()}${value.slice(1)}`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const confirmation = value as { confirmed?: unknown; status?: unknown };
  if (typeof confirmation.confirmed === 'boolean') return confirmation.confirmed ? 'Confirmed' : 'Unconfirmed';
  return renderTraceMiniConfirmation(confirmation.status);
}