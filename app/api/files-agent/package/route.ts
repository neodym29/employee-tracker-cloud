import { NextRequest, NextResponse } from 'next/server';
import { currentSession } from '@/lib/auth';
import { createFilesAgentEnrollment, filesAgentHttpError, requireSecureFilesAgentOrigin } from '@/lib/files-agent';
import { buildFilesAgentPackage, resolveFilesAgentDirectory } from '@/lib/files-agent-package';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await currentSession();
  if (!session) return NextResponse.json({ ok: false, error: 'login required' }, { status: 401 });
  const requestOrigin = req.headers.get('origin');
  if (requestOrigin && requestOrigin !== req.nextUrl.origin) return NextResponse.json({ ok: false, error: 'invalid origin' }, { status: 403 });
  const source = resolveFilesAgentDirectory();
  if (!source) return NextResponse.json({ ok: false, error: 'files-agent package source is not available' }, { status: 503 });

  try {
    const origin = requireSecureFilesAgentOrigin(process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin);
    const enrollment = await createFilesAgentEnrollment(session);
    const archive = buildFilesAgentPackage(source, origin, enrollment.token, enrollment.expires_at);
    return new NextResponse(new Uint8Array(archive), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="neodym-ai-files-tracker.zip"',
        'cache-control': 'no-store, private',
        'content-security-policy': "default-src 'none'; sandbox",
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    const failure = filesAgentHttpError(error);
    return NextResponse.json({ ok: false, error: failure.message }, { status: failure.status });
  }
}
