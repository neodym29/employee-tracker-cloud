import { NextResponse } from 'next/server';
import { currentSession } from '@/lib/auth';
import { filesAgentHttpError, listFilesAgentDevices } from '@/lib/files-agent';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await currentSession();
  if (!session) return NextResponse.json({ ok: false, error: 'login required' }, { status: 401 });
  try {
    const devices = await listFilesAgentDevices(session);
    return NextResponse.json({ ok: true, devices }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) {
    const failure = filesAgentHttpError(error);
    return NextResponse.json({ ok: false, error: failure.message }, { status: failure.status });
  }
}
