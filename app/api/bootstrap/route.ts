import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema } from '@/lib/db';

export async function POST(req: NextRequest) {
  const key = req.headers.get('x-admin-setup-key') || '';
  if (!process.env.ADMIN_SETUP_KEY || key !== process.env.ADMIN_SETUP_KEY) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  await ensureSchema();
  return NextResponse.json({ ok: true, schema: 'ready', seeded: ['hello@neodym.ai', 'ibrahim@neodym.ai'] });
}
