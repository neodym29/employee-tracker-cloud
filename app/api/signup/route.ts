import { NextRequest, NextResponse } from 'next/server';
import { health, signupEmployee } from '@/lib/db';

export async function POST(req: NextRequest) {
  if (!health().configured) return NextResponse.json({ ok: false, error: 'DATABASE_URL or POSTGRES_URL is not configured' }, { status: 503 });
  const body = await req.json().catch(() => ({}));
  try {
    const result = await signupEmployee(String(body.email || ''), String(body.password || ''));
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
