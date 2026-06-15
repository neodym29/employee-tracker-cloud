import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, health, listEventStatsForSetup, listUsersForSetup, resetExistingUserPassword, restoreAdminAccess, wipeTelemetryForSetup } from '@/lib/db';

export async function POST(req: NextRequest) {
  const key = req.headers.get('x-admin-setup-key') || '';
  if (!process.env.ADMIN_SETUP_KEY || key !== process.env.ADMIN_SETUP_KEY) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  if (!health().configured) return NextResponse.json({ ok: false, error: 'DATABASE_URL or POSTGRES_URL is not configured' }, { status: 503 });
  const body = await req.json().catch(() => ({}));
  await ensureSchema();
  if (body.action === 'list_users') {
    const users = await listUsersForSetup();
    return NextResponse.json({ ok: true, users });
  }
  if (body.action === 'event_stats') {
    const stats = await listEventStatsForSetup();
    return NextResponse.json({ ok: true, stats });
  }
  if (body.action === 'wipe_telemetry') {
    const result = await wipeTelemetryForSetup();
    return NextResponse.json({ ok: true, result });
  }
  if (body.action === 'restore_admin') {
    const admin = await restoreAdminAccess(String(body.email || ''), String(body.password || ''));
    return NextResponse.json({ ok: true, admin });
  }
  if (body.action === 'reset_user_password') {
    const user = await resetExistingUserPassword(String(body.email || ''), String(body.password || ''));
    return NextResponse.json({ ok: true, user });
  }
  return NextResponse.json({ ok: true, schema: 'ready', seeded: [] });
}
