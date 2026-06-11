import { NextResponse } from 'next/server';
import { health } from '@/lib/db';

export async function GET() {
  return NextResponse.json({ ok: true, ...health(), service: 'neodym-tracker-cloud' });
}
