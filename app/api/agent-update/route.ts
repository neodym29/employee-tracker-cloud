import { NextRequest, NextResponse } from 'next/server';
import { health, userByEnrollmentToken } from '@/lib/db';

function agentVersion() {
  return (
    process.env.NEODYM_AGENT_VERSION ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
    'dev'
  );
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') || req.headers.get('x-enrollment-token') || '';
  if (!token) return NextResponse.json({ error: 'missing token' }, { status: 400 });
  if (!health().configured) return NextResponse.json({ error: 'DATABASE_URL or POSTGRES_URL is not configured' }, { status: 503 });
  const user = await userByEnrollmentToken(token);
  if (!user) return NextResponse.json({ error: 'invalid or unapproved enrollment token' }, { status: 403 });

  const base = process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin;
  const platformParam = req.nextUrl.searchParams.get('platform') || 'linux';
  const platform = platformParam === 'windows' || platformParam === 'macos' || platformParam === 'linux' ? platformParam : 'linux';
  const installerFormat = platform === 'windows' ? '&format=cmd' : '';
  const installerUrl = `${base}/api/installer?token=${encodeURIComponent(token)}&platform=${platform}${installerFormat}`;

  return NextResponse.json({
    latest_version: agentVersion(),
    installer_url: installerUrl,
    extension_url: `${base}/api/installer?token=${encodeURIComponent(token)}&format=extension`,
    platform,
  }, {
    headers: {
      'cache-control': 'no-store',
    },
  });
}
