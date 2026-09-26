import crypto from 'crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getPool, health } from './db';
import { isSessionRevoked, revokeSessionToken } from './session-revocations';

export type SessionUser = {
  id: string;
  company_id: string;
  email: string;
  role: 'admin' | 'employee';
  account_type: 'admin' | 'client' | 'engineer';
  company_domain: string;
  session_version?: number;
};

const COOKIE_NAME = 'trace_session_v2';
const LEGACY_COOKIE_NAME = 'neodym_session';
const SESSION_TOKEN_TTL_MS = 1000 * 60 * 60 * 12;
let passwordSchemaReady: Promise<void> | null = null;

function ensurePasswordSchema() {
  if (!passwordSchemaReady) passwordSchemaReady = getPool().query('alter table app_users add column if not exists session_version integer not null default 0').then(() => undefined).catch(error => { passwordSchemaReady = null; throw error; });
  return passwordSchemaReady;
}

function authSecret(): string {
  const secret = process.env.AUTH_SECRET || process.env.ADMIN_SETUP_KEY || process.env.INGEST_API_KEY;
  if (!secret) throw new Error('AUTH_SECRET or ADMIN_SETUP_KEY must be configured for login sessions');
  return secret;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', authSecret()).update(payload).digest('base64url');
}

export function createSessionToken(user: SessionUser): string {
  const payload = Buffer.from(JSON.stringify({ ...user, sid: crypto.randomUUID(), exp: Date.now() + SESSION_TOKEN_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function parseSessionToken(token: string | undefined): SessionUser | null {
  if (!token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [payload, signature] = token.split('.');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload)))) return null;
  let parsed: SessionUser & { exp?: number };
  try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!parsed || typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp) || parsed.exp <= Date.now()) return null;
  if (parsed.role !== 'admin' && parsed.role !== 'employee') return null;
  if (!['admin', 'client', 'engineer'].includes(parsed.account_type)) return null;
  return {
    id: String(parsed.id),
    company_id: String(parsed.company_id),
    email: parsed.email,
    role: parsed.role,
    account_type: parsed.account_type,
    company_domain: parsed.company_domain,
    session_version: typeof parsed.session_version === 'number' ? parsed.session_version : 0,
  };
}

export async function setSessionCookie(user: SessionUser) {
  const jar = await cookies();
  jar.set(COOKIE_NAME, createSessionToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token && parseSessionToken(token)) {
    const { exp } = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
    // Do not report successful logout or clear the browser before durable commit.
    await revokeSessionToken(token, exp);
  }
  jar.delete(COOKIE_NAME);
  jar.delete(LEGACY_COOKIE_NAME);
}

async function getSessionUserFromDatabase(parsed: SessionUser): Promise<SessionUser | null> {
  if (!health().configured) return null;
  try {
    await ensurePasswordSchema();
    const db = getPool();
    const result = await db.query(
      `select app_users.id, app_users.company_id, app_users.email, app_users.role, app_users.account_type, app_users.session_version, companies.domain as company_domain
       from app_users join companies on companies.id=app_users.company_id
       where app_users.id=$1
         and app_users.email=$2
         and app_users.company_id=$3
         and app_users.account_type=$4
         and app_users.approval_status='approved'`,
      [parsed.id, parsed.email, parsed.company_id, parsed.account_type],
    );
    const liveUser = result.rows[0];
    if (!liveUser) return null;
    if (liveUser.session_version !== (parsed.session_version || 0)) return null;
    return {
      id: String(liveUser.id),
      company_id: String(liveUser.company_id),
      email: liveUser.email,
      role: liveUser.role,
      account_type: liveUser.account_type,
      company_domain: liveUser.company_domain,
      session_version: liveUser.session_version,
    };
  } catch {
    return null;
  }
}

export async function currentSession(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  const parsed = parseSessionToken(token);
  if (!token || !parsed) return null;
  try { if (await isSessionRevoked(token)) return null; }
  catch { return null; } // Revocation storage unavailable: fail closed.
  const liveUser = await getSessionUserFromDatabase(parsed);
  return liveUser;
}

export async function requireAdminSession(): Promise<SessionUser> {
  const session = await currentSession();
  if (!session) redirect('/login?next=/dashboard');
  if (session.role !== 'admin') redirect('/projects');
  return session;
}

export async function requirePlatformAdminSession(): Promise<SessionUser> {
  const session = await currentSession();
  if (!session || session.role !== 'admin' || session.account_type !== 'admin') redirect('/login?next=/dashboard');
  return session;
}

export async function requireEmployeeOrAdminSession(): Promise<SessionUser> {
  const session = await currentSession();
  if (!session) redirect('/login');
  return session;
}

export async function requireApprovedSession(): Promise<SessionUser> {
  const session = await currentSession();
  if (!session) redirect('/login');
  return session;
}
