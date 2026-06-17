import crypto from 'crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getPool, health } from './db';

export type SessionUser = {
  id: string;
  company_id: string;
  email: string;
  role: 'admin' | 'employee';
  company_domain: string;
};

const COOKIE_NAME = 'neodym_session';

function authSecret(): string {
  const secret = process.env.AUTH_SECRET || process.env.ADMIN_SETUP_KEY || process.env.INGEST_API_KEY;
  if (!secret) throw new Error('AUTH_SECRET or ADMIN_SETUP_KEY must be configured for login sessions');
  return secret;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', authSecret()).update(payload).digest('base64url');
}

export function createSessionToken(user: SessionUser): string {
  const payload = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + 1000 * 60 * 60 * 24 * 7 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function parseSessionToken(token: string | undefined): SessionUser | null {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.', 2);
  if (!payload || !signature || signature !== sign(payload)) return null;
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionUser & { exp?: number };
  if (!parsed.exp || parsed.exp < Date.now()) return null;
  if (parsed.role !== 'admin' && parsed.role !== 'employee') return null;
  return {
    id: String(parsed.id),
    company_id: String(parsed.company_id),
    email: parsed.email,
    role: parsed.role,
    company_domain: parsed.company_domain,
  };
}

export async function setSessionCookie(user: SessionUser) {
  const jar = await cookies();
  jar.set(COOKIE_NAME, createSessionToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}

async function getSessionUserFromDatabase(parsed: SessionUser): Promise<SessionUser | null> {
  if (!health().configured) return parsed;
  try {
    const db = getPool();
    const result = await db.query(
      `select app_users.id, app_users.company_id, app_users.email, app_users.role, companies.domain as company_domain
       from app_users join companies on companies.id=app_users.company_id
       where app_users.id=$1
         and app_users.email=$2
         and app_users.company_id=$3
         and app_users.role=$4
         and app_users.approval_status='approved'`,
      [parsed.id, parsed.email, parsed.company_id, parsed.role],
    );
    const liveUser = result.rows[0];
    if (!liveUser) return null;
    return {
      id: String(liveUser.id),
      company_id: String(liveUser.company_id),
      email: liveUser.email,
      role: liveUser.role,
      company_domain: liveUser.company_domain,
    };
  } catch {
    return null;
  }
}

export async function currentSession(): Promise<SessionUser | null> {
  const jar = await cookies();
  const parsed = parseSessionToken(jar.get(COOKIE_NAME)?.value);
  if (!parsed) return null;
  const liveUser = await getSessionUserFromDatabase(parsed);
  return liveUser;
}

export async function requireAdminSession(): Promise<SessionUser> {
  const session = await currentSession();
  if (!session || session.role !== 'admin') redirect('/login?next=/dashboard');
  return session;
}

export async function requireEmployeeOrAdminSession(): Promise<SessionUser> {
  const session = await currentSession();
  if (!session) redirect('/login');
  return session;
}
