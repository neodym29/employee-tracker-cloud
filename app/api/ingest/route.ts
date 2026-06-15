import { NextRequest, NextResponse } from 'next/server';
import { companyByDomain, ensureSchema, getPool, health, userByEnrollmentToken } from '@/lib/db';

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function richEventRows(body: any, capturedAt: string) {
  const events = Array.isArray(body.rich_events) ? body.rich_events.slice(0, 250) : [];
  return events
    .filter((event: any) => event && typeof event === 'object')
    .map((event: any) => ({
      captured_at: asString(event.captured_at, capturedAt),
      event_type: asString(event.event_type, 'detail_event'),
      app_name: asString(event.app_name || event.to_app_name || event.application_name || event.process_name),
      window_title: asString(event.window_title || event.to_window_title || event.title || event.target_hint || event.media_name),
      url: asString(event.url),
      idle_seconds: asNumber(event.idle_seconds),
      payload: event,
    }));
}

export async function POST(req: NextRequest) {
  const expected = process.env.INGEST_API_KEY;
  if (!health().configured) return NextResponse.json({ ok: false, error: 'DATABASE_URL or POSTGRES_URL is not configured' }, { status: 503 });

  const body = await req.json().catch(() => ({}));
  const enrollmentToken = req.headers.get('x-enrollment-token') || '';
  const tokenUser = enrollmentToken ? await userByEnrollmentToken(enrollmentToken) : null;
  const sharedKeyOk = Boolean(expected && req.headers.get('x-ingest-key') === expected);
  if (!sharedKeyOk && !tokenUser) return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  const employeeEmail = (tokenUser?.email || asString(body.employee_email)).toLowerCase();
  if (!employeeEmail || !employeeEmail.includes('@')) return NextResponse.json({ ok: false, error: 'employee_email is required' }, { status: 400 });
  const requestedDomain = asString(body.company_domain, employeeEmail.split('@')[1]).toLowerCase();
  const company = tokenUser ? { id: tokenUser.company_id, domain: tokenUser.domain } : await companyByDomain(requestedDomain);
  if (!company) return NextResponse.json({ ok: false, error: `${requestedDomain} is not registered` }, { status: 400 });
  if (!tokenUser && !employeeEmail.endsWith(`@${company.domain}`)) return NextResponse.json({ ok: false, error: 'employee_email must match the registered company domain' }, { status: 400 });
  const hostname = asString(body.hostname, 'unknown-host');
  const osUser = asString(body.os_user, 'unknown-user');
  const deviceKey = asString(body.device_key, `${employeeEmail}:${hostname}:${osUser}`);
  const capturedAt = asString(body.captured_at, new Date().toISOString());

  await ensureSchema();
  const db = getPool();
  const companyId = company.id;
  const user = await db.query(`select id from app_users where email=$1 and company_id=$2`, [employeeEmail, companyId]);
  const userId = user.rows[0]?.id || null;
  const device = await db.query(`
    insert into devices(company_id,user_id,device_key,employee_email,hostname,os_user,last_seen_at)
    values($1,$2,$3,$4,$5,$6,now())
    on conflict(device_key) do update set last_seen_at=now(), employee_email=excluded.employee_email, hostname=excluded.hostname, os_user=excluded.os_user, user_id=excluded.user_id
    returning id
  `, [companyId, userId, deviceKey, employeeEmail, hostname, osUser]);

  const screenshotBase64 = asString(body.screenshot_png_base64);
  const screenshotMimeType = asString(body.screenshot_mime_type, 'image/png');
  const sanitizedBody = { ...body };
  delete sanitizedBody.screenshot_png_base64;
  delete sanitizedBody.screenshot_mime_type;

  const eventResult = await db.query(`
    insert into activity_events(company_id,device_id,employee_email,hostname,os_user,captured_at,event_type,app_name,window_title,url,idle_seconds,payload)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
    returning id
  `, [companyId, device.rows[0].id, employeeEmail, hostname, osUser, capturedAt, asString(body.event_type, 'activity_snapshot'), asString(body.app_name), asString(body.window_title), asString(body.url), asNumber(body.idle_seconds), JSON.stringify(sanitizedBody)]);

  const screenshotOk = Boolean(screenshotBase64 && /^image\/(png|jpeg|webp)$/.test(screenshotMimeType) && screenshotBase64.length < 15_000_000);
  if (screenshotOk) {
    await db.query(`
      insert into activity_screenshots(activity_event_id,company_id,employee_email,captured_at,mime_type,image_base64)
      values($1,$2,$3,$4,$5,$6)
      on conflict(activity_event_id) do update set mime_type=excluded.mime_type, image_base64=excluded.image_base64
    `, [eventResult.rows[0].id, companyId, employeeEmail, capturedAt, screenshotMimeType, screenshotBase64]);
  }

  const richRows = richEventRows(body, capturedAt);
  for (const event of richRows) {
    await db.query(`
      insert into activity_events(company_id,device_id,employee_email,hostname,os_user,captured_at,event_type,app_name,window_title,url,idle_seconds,payload)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
    `, [companyId, device.rows[0].id, employeeEmail, hostname, osUser, event.captured_at, event.event_type, event.app_name, event.window_title, event.url, event.idle_seconds, JSON.stringify(event.payload)]);
  }

  if (screenshotOk) {
    const screenshotEvent = await db.query(`
      insert into activity_events(company_id,device_id,employee_email,hostname,os_user,captured_at,event_type,app_name,window_title,url,idle_seconds,payload)
      values($1,$2,$3,$4,$5,$6,'screenshot_capture',$7,$8,$9,$10,$11::jsonb)
      returning id
    `, [companyId, device.rows[0].id, employeeEmail, hostname, osUser, capturedAt, asString(body.app_name), asString(body.window_title), asString(body.url), asNumber(body.idle_seconds), JSON.stringify({ screenshot_path: asString(body.screenshot_path), source_event_id: eventResult.rows[0].id })]);
    await db.query(`
      insert into activity_screenshots(activity_event_id,company_id,employee_email,captured_at,mime_type,image_base64)
      values($1,$2,$3,$4,$5,$6)
      on conflict(activity_event_id) do update set mime_type=excluded.mime_type, image_base64=excluded.image_base64
    `, [screenshotEvent.rows[0].id, companyId, employeeEmail, capturedAt, screenshotMimeType, screenshotBase64]);
  }

  return NextResponse.json({ ok: true, employee_email: employeeEmail, hostname, rich_events: richRows.length, screenshot: screenshotOk, screenshot_rejected: Boolean(screenshotBase64 && !screenshotOk) });
}
