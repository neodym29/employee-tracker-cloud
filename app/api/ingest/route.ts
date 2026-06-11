import { NextRequest, NextResponse } from 'next/server';
import { ensureSchema, getPool, health, userByEnrollmentToken } from '@/lib/db';

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export async function POST(req: NextRequest) {
  const expected = process.env.INGEST_API_KEY;
  if (!health().configured) return NextResponse.json({ ok: false, error: 'DATABASE_URL or POSTGRES_URL is not configured' }, { status: 503 });

  const body = await req.json().catch(() => ({}));
  const enrollmentToken = req.headers.get('x-enrollment-token') || '';
  const tokenUser = enrollmentToken ? await userByEnrollmentToken(enrollmentToken) : null;
  const sharedKeyOk = Boolean(expected && req.headers.get('x-ingest-key') === expected);
  if (!sharedKeyOk && !tokenUser) return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  const employeeEmail = (tokenUser?.email || asString(body.employee_email, 'ibrahim@neodym.ai')).toLowerCase();
  if (!employeeEmail.endsWith('@neodym.ai')) return NextResponse.json({ ok: false, error: 'Only neodym.ai employees are accepted in this prototype' }, { status: 400 });
  const hostname = asString(body.hostname, 'unknown-host');
  const osUser = asString(body.os_user, 'unknown-user');
  const deviceKey = asString(body.device_key, `${employeeEmail}:${hostname}:${osUser}`);
  const capturedAt = asString(body.captured_at, new Date().toISOString());

  await ensureSchema();
  const db = getPool();
  const company = await db.query(`select id from companies where domain=$1`, ['neodym.ai']);
  const companyId = company.rows[0].id;
  const user = await db.query(`select id from app_users where email=$1`, [employeeEmail]);
  const userId = user.rows[0]?.id || null;
  const device = await db.query(`
    insert into devices(company_id,user_id,device_key,employee_email,hostname,os_user,last_seen_at)
    values($1,$2,$3,$4,$5,$6,now())
    on conflict(device_key) do update set last_seen_at=now(), employee_email=excluded.employee_email, hostname=excluded.hostname, os_user=excluded.os_user, user_id=excluded.user_id
    returning id
  `, [companyId, userId, deviceKey, employeeEmail, hostname, osUser]);

  await db.query(`
    insert into activity_events(company_id,device_id,employee_email,hostname,os_user,captured_at,event_type,app_name,window_title,url,idle_seconds,payload)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
  `, [companyId, device.rows[0].id, employeeEmail, hostname, osUser, capturedAt, asString(body.event_type, 'activity_snapshot'), asString(body.app_name), asString(body.window_title), asString(body.url), Number.isFinite(Number(body.idle_seconds)) ? Number(body.idle_seconds) : null, JSON.stringify(body)]);

  return NextResponse.json({ ok: true, employee_email: employeeEmail, hostname });
}
