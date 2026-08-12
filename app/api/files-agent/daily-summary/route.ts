import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { currentSession } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { ensureFilesAgentDailySummarySchema, persistFilesAgentDailySummary, readFilesAgentDailySummary } from '@/lib/files-agent-daily-summary';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function isCronAuthorized(req: NextRequest): boolean {
  const CRON_SECRET = process.env.CRON_SECRET || '';
  const authorization = req.headers.get('authorization') || '';
  const expected = `Bearer ${CRON_SECRET}`;
  if (!CRON_SECRET || authorization.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(authorization), Buffer.from(expected));
}

function response(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'cache-control': 'no-store, private, max-age=0' },
  });
}

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date') || undefined;
  try {
    if (isCronAuthorized(req)) {
      const db = getPool();
      // Complete idempotent DDL once before bounded, sequential tenant deliveries.
      await ensureFilesAgentDailySummarySchema(db);
      let cursor = '0';
      let delivered = 0;
      let failed = 0;
      const pageSize = 100;
      while (true) {
        const tenants = await db.query(
          `select id::text as company_id from companies where id > $1::bigint order by id limit $2`,
          [cursor, pageSize],
        );
        if (!tenants.rows.length) break;
        for (const tenant of tenants.rows) {
          cursor = String(tenant.company_id);
          try {
            await persistFilesAgentDailySummary(cursor, date, db);
            delivered += 1;
          } catch {
            failed += 1;
          }
        }
        if (tenants.rows.length < pageSize) break;
      }
      return response({ ok: failed === 0, mode: 'cron', delivered, failed }, failed ? 500 : 200);
    }

    const session = await currentSession();
    if (!session || session.role !== 'admin') {
      return response({ ok: false, error: 'admin login or cron authorization required' }, 403);
    }
    const summary = await readFilesAgentDailySummary(session.company_id, date);
    return response({ ok: true, mode: 'admin', summary });
  } catch (error) {
    const badDate = error instanceof Error && /valid YYYY-MM-DD/.test(error.message);
    return response({ ok: false, error: badDate ? 'invalid date' : 'daily summary unavailable' }, badDate ? 400 : 500);
  }
}
