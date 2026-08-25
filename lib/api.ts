import { NextRequest, NextResponse } from 'next/server';
import { currentSession, type SessionUser } from './auth';
import { ProjectServiceError } from './projects';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message);
  }
}

export function assertSameOrigin(req: NextRequest) {
  const origin = req.headers.get('origin');
  const allowed = new Set([req.nextUrl.origin]);
  if (process.env.NEXT_PUBLIC_APP_URL) {
    try { allowed.add(new URL(process.env.NEXT_PUBLIC_APP_URL).origin); } catch { /* invalid configuration never broadens access */ }
  }
  if (!origin || !allowed.has(origin)) throw new ApiError('Invalid origin', 403, 'invalid_origin');
}

export async function requireApiSession(accountType?: SessionUser['account_type']) {
  const session = await currentSession();
  if (!session) throw new ApiError('Authentication required', 401, 'unauthorized');
  if (accountType && session.account_type !== accountType) throw new ApiError('Forbidden', 403, 'forbidden');
  return session;
}

export async function requirePlatformAdminApiSession() {
  const session = await requireApiSession('admin');
  if (session.role !== 'admin' || session.account_type !== 'admin') throw new ApiError('Forbidden', 403, 'forbidden');
  return session;
}

export function apiErrorResponse(error: unknown) {
  if (error instanceof ApiError || error instanceof ProjectServiceError) {
    return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: error.status });
  }
  console.error('API request failed', error);
  return NextResponse.json({ ok: false, error: 'Request could not be completed', code: 'internal_error' }, { status: 500 });
}

export async function jsonBody(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new ApiError('Invalid JSON body', 400, 'invalid_json');
  }
}
