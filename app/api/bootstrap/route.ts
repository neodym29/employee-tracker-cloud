import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, health } from '@/lib/db';

export async function POST(req: NextRequest) {
  const key = req.headers.get('x-admin-setup-key') || '';
  if (!process.env.ADMIN_SETUP_KEY || key !== process.env.ADMIN_SETUP_KEY) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  if (!health().configured) return NextResponse.json({ ok: false, error: 'DATABASE_URL or POSTGRES_URL is not configured' }, { status: 503 });
  await ensureSchema();
  return NextResponse.json({ ok: true, schema: 'ready', seeded: ['hello@neodym.ai', 'ibrahim@neodym.ai'] });
}
