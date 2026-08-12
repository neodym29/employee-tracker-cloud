import { NextRequest, NextResponse } from 'next/server';
import { bearerSecret, exchangeFilesAgentEnrollment, filesAgentHttpError } from '@/lib/files-agent';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const token = bearerSecret(req);
  if (!token) return NextResponse.json({ ok: false, error: 'Bearer enrollment token required' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ ok: false, error: 'JSON object required' }, { status: 400 });
  try {
    const device = await exchangeFilesAgentEnrollment(token, body);
    return NextResponse.json({ ok: true, ...device }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const failure = filesAgentHttpError(error);
    return NextResponse.json({ ok: false, error: failure.message }, { status: failure.status });
  }
}
