import { NextRequest, NextResponse } from 'next/server';
import { currentSession } from '@/lib/auth';
import { createFilesAgentEnrollment, filesAgentHttpError } from '@/lib/files-agent';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ ok: false, error: 'login required' }, { status: 401 });
  const origin = req.headers.get('origin');
  if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ ok: false, error: 'invalid origin' }, { status: 403 });
  try {
    const enrollment = await createFilesAgentEnrollment(session);
    return NextResponse.json({ ok: true, enrollment_token: enrollment.token, expires_at: enrollment.expires_at }, {
      headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    });
  } catch (error) {
    const failure = filesAgentHttpError(error);
    return NextResponse.json({ ok: false, error: failure.message }, { status: failure.status });
  }
}
