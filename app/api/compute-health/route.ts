import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const response = await fetch('https://compute.neodym.ai/api/health', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) throw new Error('compute unavailable');
    const payload = await response.json() as Record<string, unknown>;
    if (payload.ok !== true) throw new Error('compute unhealthy');
    return NextResponse.json({ online: true, checkedAt: new Date().toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ online: false, checkedAt: new Date().toISOString() }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
