import { NextRequest, NextResponse } from 'next/server';
import { currentSession } from '@/lib/auth';
import { filesAgentHttpError, revokeFilesAgentDevice } from '@/lib/files-agent';

export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, context: { params: Promise<{ deviceId: string }> }) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ ok: false, error: 'login required' }, { status: 401 });
  if (req.headers.get('origin') !== req.nextUrl.origin) {
    return NextResponse.json({ ok: false, error: 'invalid origin' }, { status: 403 });
  }
  try {
    const { deviceId } = await context.params;
    const device = await revokeFilesAgentDevice(session, deviceId);
    return NextResponse.json({ ok: true, device }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) {
    const failure = filesAgentHttpError(error);
    return NextResponse.json({ ok: false, error: failure.message }, { status: failure.status });
  }
}
