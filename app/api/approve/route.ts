import { NextRequest, NextResponse } from 'next/server';
import { approveEmployee, health } from '@/lib/db';
import { currentSession } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const session = await currentSession();
  if (!session || session.role !== 'admin') {
    return NextResponse.json({ ok: false, error: 'admin login required' }, { status: 403 });
  }
  if (!health().configured) return NextResponse.json({ ok: false, error: 'DATABASE_URL or POSTGRES_URL is not configured' }, { status: 503 });
  const body = await req.json().catch(() => ({}));
  try {
    const result = await approveEmployee(String(body.email || ''));
    const base = process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin;
    return NextResponse.json({ ok: true, email: result.email, installer_url: `${base}/api/installer?token=${result.enrollment_token}` });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
