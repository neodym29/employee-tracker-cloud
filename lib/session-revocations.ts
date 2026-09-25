import crypto from 'crypto';
import { getPool } from './db';

// Additive, rolling-compatible denylist: existing signed sessions stay valid until
// explicitly logged out. Store only a digest, never a reusable credential.
let ready: Promise<void> | null = null;
export function ensureSessionRevocations(): Promise<void> {
  if (!ready) {
    ready = getPool().query(`create table if not exists auth_session_revocations (
      token_hash text primary key check (length(token_hash) = 64),
      expires_at timestamptz not null,
      revoked_at timestamptz not null default now()
    )`).then(() => undefined).catch(error => { ready = null; throw error; });
  }
  return ready;
}
function digest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
export async function revokeSessionToken(token: string, expiresAt: number): Promise<void> {
  await ensureSessionRevocations();
  await getPool().query(`insert into auth_session_revocations(token_hash, expires_at)
    values($1,$2) on conflict(token_hash) do nothing`, [digest(token), new Date(expiresAt)]);
}
export async function isSessionRevoked(token: string): Promise<boolean> {
  await ensureSessionRevocations();
  const result = await getPool().query('select 1 from auth_session_revocations where token_hash=$1', [digest(token)]);
  return result.rowCount !== 0;
}
