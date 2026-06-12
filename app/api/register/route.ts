import { NextRequest, NextResponse } from 'next/server';
import { health, registerCompanyWithAdmin } from '@/lib/db';

export async function POST(req: NextRequest) {
  if (!health().configured) return NextResponse.json({ ok: false, error: 'DATABASE_URL or POSTGRES_URL is not configured' }, { status: 503 });
  const body = await req.json().catch(() => ({}));
  try {
    const result = await registerCompanyWithAdmin(String(body.company_name || ''), String(body.admin_email || ''), String(body.admin_password || ''));
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
