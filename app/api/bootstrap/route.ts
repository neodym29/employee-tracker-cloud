import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, health, listEventStatsForSetup, listUsersForSetup, optimizeTelemetryIndexesForSetup, repairTelemetrySequencesForSetup, resetExistingUserPassword, restoreAdminAccess, setTelemetryPauseForSetup, wipeTelemetryBatchForSetup } from '@/lib/db';
import { wipeFilesAgentDailySummariesForSetup, withFilesAgentSummaryWipeLock } from '@/lib/files-agent-daily-summary';

async function wipeTelemetryAndSummariesBatch(limit: number) {
  return withFilesAgentSummaryWipeLock(async (db) => {
    const result = await wipeTelemetryBatchForSetup(limit);
    const filesAgentDailySummaries = await wipeFilesAgentDailySummariesForSetup(limit, db);
    return {
      ...result,
      filesAgentDailySummaries,
      done: result.done && filesAgentDailySummaries === 0,
    };
  });
}

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
    await setTelemetryPauseForSetup(true);
    let result;
    do {
      result = await wipeTelemetryAndSummariesBatch(50000);
    } while (!result.done);
    return NextResponse.json({ ok: true, result });
  }
  if (body.action === 'set_telemetry_pause') {
    const result = await setTelemetryPauseForSetup(Boolean(body.paused));
    return NextResponse.json({ ok: true, result });
  }
  if (body.action === 'wipe_telemetry_batch') {
    const limit = Number(body.limit || 10000);
    await setTelemetryPauseForSetup(true);
    const result = await wipeTelemetryAndSummariesBatch(limit);
    return NextResponse.json({ ok: true, result });
  }
  if (body.action === 'repair_sequences') {
    const result = await repairTelemetrySequencesForSetup();
    return NextResponse.json({ ok: true, result });
  }
  if (body.action === 'optimize_indexes') {
    const result = await optimizeTelemetryIndexesForSetup();
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
