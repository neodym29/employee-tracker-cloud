import { NextRequest, NextResponse } from 'next/server';
import { health, loginUser } from '@/lib/db';
import { setSessionCookie } from '@/lib/auth';
import { apiErrorResponse, assertSameOrigin, jsonBody } from '@/lib/api';

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    if (!health().configured) return NextResponse.json({ ok: false, error: 'Service unavailable' }, { status: 503 });
    const body = await jsonBody(req);
    const user = await loginUser(String(body.email || ''), String(body.password || ''));
    await setSessionCookie(user);
    return NextResponse.json({ ok: true, user: { email: user.email, role: user.role, account_type: user.account_type, company_domain: user.company_domain } });
  } catch (error) {
    if (error instanceof Error && ['Invalid email or password', 'Account is not approved', 'Enter a valid work email'].includes(error.message)) {
      return NextResponse.json({ ok: false, error: error.message === 'Enter a valid work email' ? 'Invalid email or password' : error.message }, { status: 401 });
    }
    return apiErrorResponse(error);
  }
}
