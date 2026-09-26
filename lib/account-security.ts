import crypto from 'node:crypto';
import { ApiError } from './api';
import type { SessionUser } from './auth';
import { getPool, hashPassword, verifyPassword } from './db';
import { ensureProfilesSchema } from './profiles';

export async function changeOwnPassword(session: SessionUser, currentPassword: unknown, newPassword: unknown): Promise<number> {
  if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 1024 || typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 1024) {
    throw new ApiError('Enter your current password and a new password of 8–1024 characters', 400, 'invalid_password');
  }
  await ensureProfilesSchema();
  const db = await getPool().connect();
  let version = 0;
  try {
    await db.query('begin');
    const result = await db.query('select password_hash from app_users where id=$1 and company_id=$2 for update', [session.id, session.company_id]);
    const stored = result.rows[0]?.password_hash as string | null | undefined;
    if (!stored || !verifyPassword(currentPassword, stored)) throw new ApiError('Current password is incorrect', 400, 'incorrect_password');
    if (verifyPassword(newPassword, stored)) throw new ApiError('Choose a password different from your current one', 400, 'same_password');
    const updated = await db.query('update app_users set password_hash=$2,password_changed_at=now(),session_version=session_version+1 where id=$1 returning session_version', [session.id, hashPassword(newPassword)]);
    version = updated.rows[0].session_version;
    await db.query('commit');
  } catch (error) { await db.query('rollback'); throw error; }
  finally { db.release(); }
  return version;
}

export function verificationDeliveryConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM && process.env.NEXT_PUBLIC_APP_URL);
}

export async function sendOwnEmailVerification(session: SessionUser) {
  if (!verificationDeliveryConfigured()) throw new ApiError('Email verification is not available yet. Ask an administrator to configure email delivery.', 503, 'email_not_configured');
  await ensureProfilesSchema();
  const origin = new URL(process.env.NEXT_PUBLIC_APP_URL!);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:')) {
    throw new ApiError('Email verification is not configured correctly', 503, 'email_not_configured');
  }
  const user = await getPool().query('select email,email_verified_at from app_users where id=$1 and company_id=$2', [session.id, session.company_id]);
  if (!user.rows[0]) throw new ApiError('Account not found', 404, 'not_found');
  if (user.rows[0].email_verified_at) return { alreadyVerified: true };
  const email = user.rows[0].email as string;
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const stored = await getPool().query(`insert into email_verification_tokens(user_id,email,token_hash,expires_at,sent_at)
    values($1,$2,$3,now()+interval '30 minutes',now())
    on conflict(user_id) do update set email=excluded.email,token_hash=excluded.token_hash,expires_at=excluded.expires_at,sent_at=now()
    where email_verification_tokens.sent_at < now()-interval '60 seconds'
    returning user_id`, [session.id, email, tokenHash]);
  if (!stored.rowCount) throw new ApiError('Wait a minute before requesting another email', 429, 'rate_limited');
  const link = new URL('/verify-email', origin);
  link.searchParams.set('token', token);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [email], subject: 'Verify your Neo-Nexus email', text: `Open this link to verify your Neo-Nexus email address. It expires in 30 minutes.\n\n${link.toString()}\n\nIf you did not request this, ignore this message.` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
  } catch (error) {
    await getPool().query('delete from email_verification_tokens where user_id=$1 and token_hash=$2', [session.id, tokenHash]);
    console.error('Verification email delivery failed', error);
    throw new ApiError('Could not send verification email. Try again later.', 503, 'email_delivery_failed');
  }
  return { alreadyVerified: false };
}

export async function confirmOwnEmailVerification(session: SessionUser, token: unknown) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError('Invalid verification link', 400, 'invalid_token');
  await ensureProfilesSchema();
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const db = await getPool().connect();
  try {
    await db.query('begin');
    const result = await db.query(`delete from email_verification_tokens t
      using app_users u where t.user_id=u.id and u.id=$1 and u.company_id=$2 and u.email=t.email
      and t.token_hash=$3 and t.expires_at>now() returning u.id`, [session.id, session.company_id, hash]);
    if (!result.rowCount) throw new ApiError('This verification link is expired or invalid. Request a new one from Profile.', 400, 'invalid_token');
    await db.query('update app_users set email_verified_at=now() where id=$1 and company_id=$2', [session.id, session.company_id]);
    await db.query('commit');
  } catch (error) { await db.query('rollback'); throw error; }
  finally { db.release(); }
}
