import { NextRequest, NextResponse } from 'next/server';
import { health, loginUser } from '@/lib/db';
import { setSessionCookie } from '@/lib/auth';

export async function POST(req: NextRequest) {
  if (!health().configured) return NextResponse.json({ ok: false, error: 'DATABASE_URL or POSTGRES_URL is not configured' }, { status: 503 });
  const body = await req.json().catch(() => ({}));
  try {
    const user = await loginUser(String(body.email || ''), String(body.password || ''));
    await setSessionCookie(user);
    return NextResponse.json({ ok: true, user: { email: user.email, role: user.role, company_domain: user.company_domain } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 401 });
  }
}
