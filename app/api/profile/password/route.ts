import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { setSessionCookie } from '@/lib/auth';
import { changeOwnPassword } from '@/lib/account-security';

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireApiSession();
    const body = await jsonBody(req);
    const version = await changeOwnPassword(session, body.currentPassword, body.newPassword);
    // Password changes invalidate every older session; keep this browser signed in with a fresh token.
    await setSessionCookie({ ...session, session_version: version });
    return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) { return apiErrorResponse(error); }
}
