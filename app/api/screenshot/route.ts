import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession } from '@/lib/auth';
import { ensureSchema, getPool, health } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  await requireAdminSession();
  if (!health().configured) return NextResponse.json({ ok: false, error: 'DATABASE_URL or POSTGRES_URL is not configured' }, { status: 503 });
  const id = Number(req.nextUrl.searchParams.get('id') || '0');
  if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ ok: false, error: 'valid screenshot event id is required' }, { status: 400 });
  await ensureSchema();
  const db = getPool();
  const result = await db.query(
    `select s.mime_type, s.image_base64, e.employee_email, e.hostname, e.captured_at
     from activity_events e
     join activity_screenshots s on s.activity_event_id = e.id
       or s.activity_event_id = case when (e.payload->>'source_event_id') ~ '^\\d+$' then (e.payload->>'source_event_id')::bigint end
     where e.id = $1
     order by case when s.activity_event_id = e.id then 0 else 1 end
     limit 1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return NextResponse.json({ ok: false, error: 'screenshot not found' }, { status: 404 });
  return NextResponse.json({
    ok: true,
    mime_type: row.mime_type || 'image/png',
    image: `data:${row.mime_type || 'image/png'};base64,${row.image_base64}`,
    employee_email: row.employee_email,
    hostname: row.hostname,
    captured_at: row.captured_at,
  });
}
