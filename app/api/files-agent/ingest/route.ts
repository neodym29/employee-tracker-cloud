import { NextRequest, NextResponse } from 'next/server';
import { bearerSecret, filesAgentHttpError, ingestFilesAgentEvents } from '@/lib/files-agent';
import { telemetryPaused } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const credential = bearerSecret(req);
  if (!credential) return NextResponse.json({ ok: false, error: 'Bearer device credential required' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ ok: false, error: 'JSON object required' }, { status: 400 });
  try {
    if (await telemetryPaused()) return NextResponse.json({ ok: false, error: 'telemetry temporarily paused for reset' }, { status: 503 });
    const result = await ingestFilesAgentEvents(credential, body as Record<string, unknown>);
    return NextResponse.json({ ok: true, ...result }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const failure = filesAgentHttpError(error);
    return NextResponse.json({ ok: false, error: failure.message }, { status: failure.status });
  }
}
