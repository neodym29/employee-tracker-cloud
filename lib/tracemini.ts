import 'server-only';
import crypto from 'node:crypto';
import type { SessionUser } from './auth';
import { ensureSchema, getPool } from './db';
import { ProjectServiceError, projectAccessSql } from './projects';

function projectId(value: unknown): string {
  const result = String(value ?? '');
  if (!/^[1-9]\d*$/.test(result)) throw new ProjectServiceError('Invalid project id');
  return result;
}
function admin(session: SessionUser) { return session.role === 'admin' && session.account_type === 'admin'; }
export function isTraceMiniManager(session: Pick<SessionUser, 'id' | 'role' | 'account_type'>, ownerId: string) {
  return admin(session as SessionUser) || (session.account_type === 'client' && session.id === String(ownerId));
}
async function db() { await ensureSchema(); return getPool(); }
async function authorized(session: SessionUser, project: string) {
  const pool = await db();
  const access = projectAccessSql('$2');
  const result = await pool.query(
    `select p.id,p.client_id,p.tracemini_telemetry_paused,p.tracemini_retention_days
       from projects p ${admin(session) ? '' : access.join}
      where p.id=$1 and p.approval_status='approved' and ${admin(session) ? 'true' : access.predicate}`,
    admin(session) ? [project] : [project, session.id],
  );
  if (!result.rows[0]) throw new ProjectServiceError('Project not found', 404, 'not_found');
  return { pool, row: result.rows[0] };
}

export async function getTraceMiniConfig(session: SessionUser, value: unknown) {
  const project = projectId(value); const { pool, row } = await authorized(session, project);
  const roots = await pool.query(`select r.binding_id,r.root_label,r.status,r.last_heartbeat_at,r.created_at,d.device_label,d.hostname from project_tracemini_roots r join files_agent_devices d on d.id=r.device_id where r.project_id=$1 order by r.created_at desc`, [project]);
  const manager = isTraceMiniManager(session, String(row.client_id));
  const safeRoots = roots.rows.map((root, index) => ({ ...(manager ? { managementId: String(root.binding_id || `root-${index}`) } : {}), label: String(root.root_label), status: String(root.status), lastHeartbeatAt: root.last_heartbeat_at ? new Date(root.last_heartbeat_at).toISOString() : null, createdAt: new Date(root.created_at).toISOString() }));
  return { configured: true, enabled: !row.tracemini_telemetry_paused, hasCredential: false, baseUrl: null, workspaceId: null,
    approvedRoots: safeRoots.filter((root) => root.status === 'approved').length, roots: safeRoots, retentionDays: Number(row.tracemini_retention_days || 90),
    lastSuccessfulSync: null, lastError: null };
}

export async function saveTraceMiniConfig(session: SessionUser, value: unknown, input: Record<string, unknown>) {
  const project = projectId(value); const { pool, row } = await authorized(session, project);
  if (!isTraceMiniManager(session, String(row.client_id))) throw new ProjectServiceError('Forbidden', 403, 'forbidden');
  if ('baseUrl' in input || 'workspaceId' in input || 'credential' in input) throw new ProjectServiceError('Embedded TraceMini does not accept external configuration', 400, 'invalid_request');
  const paused = typeof input.enabled === 'boolean' ? !input.enabled : row.tracemini_telemetry_paused;
  const retention = typeof input.retentionDays === 'number' && Number.isInteger(input.retentionDays) ? Math.max(1, Math.min(input.retentionDays, 3650)) : Number(row.tracemini_retention_days || 90);
  await pool.query(`update projects set tracemini_telemetry_paused=$2,tracemini_retention_days=$3,updated_at=now() where id=$1`, [project, paused, retention]);
  return getTraceMiniConfig(session, project);
}
export async function revokeTraceMiniRoot(session: SessionUser, value: unknown, bindingId: unknown) {
  const project=projectId(value); const {pool,row}=await authorized(session,project);
  if(!isTraceMiniManager(session,String(row.client_id))) throw new ProjectServiceError('Forbidden',403,'forbidden');
  const binding=String(bindingId??''); if(!/^[A-Za-z0-9_-]{32,128}$/.test(binding)) throw new ProjectServiceError('Invalid binding id',400,'invalid_request');
  const result=await pool.query(`update project_tracemini_roots set status='revoked',revoked_at=now() where project_id=$1 and binding_id=$2 and status<>'revoked' returning binding_id`,[project,binding]);
  if(!result.rows[0]) throw new ProjectServiceError('Root not found',404,'not_found'); return {revoked:true,bindingId:binding};
}

export async function setTraceMiniEnabled(session: SessionUser, value: unknown, enabled: boolean) { return saveTraceMiniConfig(session, value, { enabled }); }
export async function removeTraceMiniConfig(session: SessionUser, value: unknown) { return setTraceMiniEnabled(session, value, false).then(() => ({ removed: true })); }
export async function testTraceMiniConnection(session: SessionUser, value: unknown) {
  const config = await getTraceMiniConfig(session, value);
  return { connected: true, embedded: true, telemetryPaused: !config.enabled, approvedRoots: config.approvedRoots };
}
export async function wipeTraceMiniTelemetry(session: SessionUser, value: unknown) {
  const project = projectId(value); const { pool, row } = await authorized(session, project);
  if (!isTraceMiniManager(session, String(row.client_id))) throw new ProjectServiceError('Forbidden', 403, 'forbidden');
  const client = await pool.connect();
  try { await client.query('begin');
    await client.query(`update projects set tracemini_telemetry_paused=true,tracemini_resume_epoch=tracemini_resume_epoch+1,updated_at=now() where id=$1`, [project]);
    const events = await client.query(`delete from project_tracemini_events where project_id=$1`, [project]);
    const reports = await client.query(`delete from project_tracemini_reports where project_id=$1`, [project]);
    const audit = await client.query(`insert into tracemini_audit_log(project_id,actor_user_id,action,details) values($1,$2,'telemetry_wipe',$3::jsonb) returning id`, [project, session.id, JSON.stringify({ events: events.rowCount || 0, reports: reports.rowCount || 0, evidenceRetained: true })]);
    await client.query('commit');
    return { wiped: true, projectId: project, evidenceRetained: true, events: events.rowCount || 0, reports: reports.rowCount || 0, telemetryPaused: true, auditId: String(audit.rows[0].id), resumeEpoch: true };
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}

export function validateTraceMiniDashboardEnvelope(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid embedded TraceMini dashboard response');
  return value as { events: unknown[]; repositories: unknown[]; stats: Record<string, unknown>; timeline: unknown[] };
}

export async function getTraceMiniData(session: SessionUser, value: unknown, filters: { from?: string; to?: string } = {}) {
  const project = projectId(value); const { pool, row } = await authorized(session, project);
  if (row.tracemini_telemetry_paused) return { state: 'disabled', stale: false, lastSuccessfulSync: null, lastError: null, data: null };
  const params: unknown[] = [project]; const where = ['e.project_id=$1'];
  if (filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from)) { params.push(filters.from); where.push(`e.occurred_at >= $${params.length}::date`); }
  if (filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to)) { params.push(filters.to); where.push(`e.occurred_at < ($${params.length}::date + interval '1 day')`); }
  const events = await pool.query(
    `select e.id,e.event_key,e.kind,e.repository_key,e.occurred_at,e.provenance,e.evidence_eligible,u.display_name
       from project_tracemini_events e join files_agent_devices d on d.id=e.device_id
       join app_users u on u.id=d.user_id where ${where.join(' and ')} order by e.occurred_at desc,e.id desc limit 250`, params);
  const recentActivity = events.rows.map((event) => { const provenance = event.provenance && typeof event.provenance === 'object' ? event.provenance as Record<string, unknown> : {};
    const evidenceEligible = event.evidence_eligible === true;
    return { id: String(event.id), upstreamId: String(event.event_key), evidenceEligible,
    type: String(event.kind), occurredAt: new Date(event.occurred_at).toISOString(), repositoryName: String(event.repository_key || ''),
    member: { mapped: true, label: typeof event.display_name === 'string' ? event.display_name : 'Project member' },
    data: provenance }; });
  const counts = recentActivity.reduce((result, event) => { result[event.type] = (result[event.type] || 0) + 1; return result; }, {} as Record<string, number>);
  return { state: 'fresh', stale: false, lastSuccessfulSync: new Date().toISOString(), lastError: null,
    data: { matchStatus: 'embedded', matchedRepository: null, hasLocalClone: recentActivity.some((event) => event.type === 'git'),
      localCloneCount: recentActivity.filter((event) => event.type === 'git').length, activityTotal: recentActivity.length, recentActivity,
      repositories: [...new Set(recentActivity.map((event) => event.repositoryName).filter(Boolean))].map((name) => ({ name, events: recentActivity.filter((event) => event.repositoryName === name).length })),
      devices: (await pool.query(`select device_label,last_seen_at,revoked_at from files_agent_devices where id in (select distinct device_id from project_tracemini_events where project_id=$1) order by last_seen_at desc`, [project])).rows.map((device, index) => ({ label: `Approved device ${index + 1}`, status: device.revoked_at ? 'revoked' : 'active', lastSeen: device.last_seen_at ? new Date(device.last_seen_at).toISOString() : null })),
      memberActivity: Object.values(recentActivity.reduce((all, event) => { const key = event.member.label; (all[key] ||= { member: key, events: 0 }).events++; return all; }, {} as Record<string, { member: string; events: number }>)),
      reports: (await pool.query(`select id,name,scope,reporter,format,status,start_date,end_date,created_at,completed_at from project_tracemini_reports where project_id=$1 order by created_at desc limit 50`, [project])).rows.map((report) => ({ id: String(report.id), title: String(report.name), scope: report.scope, reporter: report.reporter, format: report.format, status: report.status, createdAt: new Date(report.created_at).toISOString(), completedAt: report.completed_at ? new Date(report.completed_at).toISOString() : null })),
      stats: counts } };
}

/** Compatibility name retained for the old route. It deliberately creates no progress mutation. */
export async function proposeTraceMiniProgressForProject(session: SessionUser, value: unknown) {
  const project = projectId(value); await authorized(session, project); return false;
}
export async function proposeTraceMiniProgress() { return null; }

function reportDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new ProjectServiceError(`${label} must be YYYY-MM-DD`, 400, 'invalid_request');
  return value;
}

export async function listTraceMiniReports(session: SessionUser, value: unknown) {
  const project = projectId(value); const { pool, row } = await authorized(session, project);
  const manager = isTraceMiniManager(session, String(row.client_id));
  return (await pool.query(`select id,name,scope,reporter,format,status,attempt_count,next_run_at,slack_status,start_date,end_date,created_at,completed_at,parent_report_id from project_tracemini_reports where project_id=$1 and ($2 or scope='workspace' or requested_by=$3) order by created_at desc limit 100`, [project, manager, session.id])).rows.map((report) => ({ ...report, id: String(report.id), parentReportId: report.parent_report_id ? String(report.parent_report_id) : null }));
}

export async function getTraceMiniReport(session: SessionUser, value: unknown, reportValue: unknown) {
  const project = projectId(value); const report = String(reportValue ?? ''); if (!/^\d+$/.test(report)) throw new ProjectServiceError('Invalid report id', 400, 'invalid_request');
  const { pool, row } = await authorized(session, project); const manager = isTraceMiniManager(session, String(row.client_id));
  const result = await pool.query(`select id,name,scope,reporter,format,status,attempt_count,next_run_at,slack_status,start_date,end_date,created_at,completed_at,parent_report_id,markdown,last_error from project_tracemini_reports where id=$1 and project_id=$2 and ($3 or scope='workspace' or requested_by=$4)`, [report, project, manager, session.id]);
  if (!result.rows[0]) throw new ProjectServiceError('Report not found', 404, 'not_found');
  return result.rows[0];
}

export async function createTraceMiniReport(session: SessionUser, value: unknown, input: Record<string, unknown>) {
  const project = projectId(value); const { pool, row } = await authorized(session, project);
  const manager = isTraceMiniManager(session, String(row.client_id));
  const unknown = Object.keys(input).find((key) => !['scope','reporter','format','name','prompt','startDate','endDate','includeDiff','diffConsent','documents','notifySlack'].includes(key));
  if (unknown) throw new ProjectServiceError(`Unknown report field: ${unknown}`, 400, 'invalid_request');
  const start = reportDate(input.startDate, 'startDate'), end = reportDate(input.endDate, 'endDate');
  if (end < start || Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`) > 366 * 86400000) throw new ProjectServiceError('report date window is invalid', 400, 'invalid_request');
  const scope = input.scope === 'workspace' ? 'workspace' : 'personal'; if (scope === 'workspace' && !manager) throw new ProjectServiceError('Workspace reports require manager access', 403, 'forbidden');
  const reporter = input.reporter === 'hermes' ? 'hermes' : input.reporter === 'codex' ? 'codex' : (() => { throw new ProjectServiceError('Invalid reporter', 400, 'invalid_request'); })();
  const format = ['markdown','pdf','pptx'].includes(String(input.format)) ? String(input.format) : (() => { throw new ProjectServiceError('Invalid report format', 400, 'invalid_request'); })();
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 160) : 'TraceMini report';
  const prompt = input.prompt === undefined ? null : typeof input.prompt === 'string' && Buffer.byteLength(input.prompt,'utf8') <= 20000 ? input.prompt : (() => { throw new ProjectServiceError('Prompt exceeds bound',400,'invalid_request'); })();
  const includeDiff = input.includeDiff === true; if (includeDiff && input.diffConsent !== true) throw new ProjectServiceError('bounded diff requires explicit consent', 400, 'invalid_request');
  const documents = Array.isArray(input.documents) ? input.documents : [];
  if (documents.length > 5 || documents.some((document) => !document || typeof document !== 'object' || Object.keys(document as object).some((key) => !['format','bytes','sha256'].includes(key)) || !['pdf','pptx'].includes(String((document as Record<string,unknown>).format)) || !Number.isSafeInteger((document as Record<string,unknown>).bytes) || Number((document as Record<string,unknown>).bytes) < 0 || Number((document as Record<string,unknown>).bytes) > 25 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(String((document as Record<string,unknown>).sha256)))) throw new ProjectServiceError('Invalid bounded document metadata', 400, 'invalid_request');
  const dedupe = cryptoHash(`${project}:${session.id}:${start}:${end}:${reporter}:${format}:${name}`);
  const notifySlack = input.notifySlack === true && Boolean(process.env.SLACK_REPORT_WEBHOOK_URL);
  const result = await pool.query(`insert into project_tracemini_reports(project_id,requested_by,scope,reporter,name,format,prompt,start_date,end_date,include_diff,documents,status,dedupe_key,notify_slack,slack_status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13,case when $13 then 'pending' else 'not_requested' end) on conflict(dedupe_key) do update set name=excluded.name returning *`, [project, session.id, scope, reporter, name, format, prompt, start, end, includeDiff, JSON.stringify(documents), dedupe, notifySlack]);
  return result.rows[0];
}

export async function regenerateTraceMiniReport(session:SessionUser,value:unknown,reportValue:unknown){
  const project=projectId(value); const {pool,row}=await authorized(session,project); if(!isTraceMiniManager(session,String(row.client_id))) throw new ProjectServiceError('Forbidden',403,'forbidden');
  const report=String(reportValue??''); if(!/^\d+$/.test(report)) throw new ProjectServiceError('Invalid report id',400,'invalid_request');
  const result=await pool.query(`insert into project_tracemini_reports(project_id,requested_by,scope,reporter,name,format,prompt,start_date,end_date,include_diff,documents,parent_report_id,status,dedupe_key,slack_status) select project_id,$3,scope,reporter,name,format,prompt,start_date,end_date,include_diff,documents,id,'pending',$4,'not_requested' from project_tracemini_reports where id=$1 and project_id=$2 returning *`,[report,project,session.id,crypto.randomUUID()]);
  if(!result.rows[0]) throw new ProjectServiceError('Report not found',404,'not_found'); return result.rows[0];
}

export async function getTraceMiniSchedule(session: SessionUser, value: unknown) {
  const project = projectId(value); const { pool } = await authorized(session, project);
  return (await pool.query(`select * from project_tracemini_schedules where project_id=$1 limit 1`, [project])).rows[0] || null;
}

export async function saveTraceMiniSchedule(session: SessionUser, value: unknown, input: Record<string, unknown>) {
  const project = projectId(value); const { pool, row } = await authorized(session, project);
  if (!isTraceMiniManager(session, String(row.client_id))) throw new ProjectServiceError('Forbidden', 403, 'forbidden');
  const unknown = Object.keys(input).find((key) => !['name','frequency','selectedDays','localTime','timezone','reporter','format','prompt','includeDiff','diffConsent','documents','notifySlack','enabled'].includes(key));
  if (unknown) throw new ProjectServiceError(`Unknown schedule field: ${unknown}`,400,'invalid_request');
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 160) : 'TraceMini schedule';
  const frequency = ['daily','weekdays','selected_days'].includes(String(input.frequency)) ? String(input.frequency) : (() => { throw new ProjectServiceError('Invalid schedule frequency',400,'invalid_request'); })();
  const reporter = input.reporter === 'hermes' ? 'hermes' : input.reporter === 'codex' ? 'codex' : (() => { throw new ProjectServiceError('Invalid reporter',400,'invalid_request'); })();
  const format = ['markdown','pdf','pptx'].includes(String(input.format)) ? String(input.format) : (() => { throw new ProjectServiceError('Invalid schedule format',400,'invalid_request'); })();
  const days = Array.isArray(input.selectedDays) ? input.selectedDays.filter((day) => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6) : [];
  if (frequency === 'selected_days' && !days.length) throw new ProjectServiceError('selected_days requires selectedDays',400,'invalid_request');
  const time = typeof input.localTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.localTime) ? input.localTime : (() => { throw new ProjectServiceError('Invalid local time',400,'invalid_request'); })();
  const timezone = typeof input.timezone === 'string' && input.timezone.length <= 100 ? input.timezone : (() => { throw new ProjectServiceError('Invalid IANA timezone',400,'invalid_request'); })();
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch { throw new ProjectServiceError('Invalid IANA timezone',400,'invalid_request'); }
  const next = computeNextSchedule(frequency, time, timezone, days);
  const dedupe = cryptoHash(`${project}:${name}:${frequency}:${time}:${JSON.stringify(days)}`);
  const schedulePrompt = input.prompt === undefined ? null : typeof input.prompt === 'string' && Buffer.byteLength(input.prompt,'utf8') <= 20000 ? input.prompt : (() => { throw new ProjectServiceError('Prompt exceeds bound',400,'invalid_request'); })();
  const scheduleDocuments = Array.isArray(input.documents) ? input.documents : [];
  if (scheduleDocuments.length > 5 || scheduleDocuments.some((document) => !document || typeof document !== 'object' || Object.keys(document as object).some((key) => !['format','bytes','sha256'].includes(key)))) throw new ProjectServiceError('Invalid bounded document metadata',400,'invalid_request');
  const result = await pool.query(`insert into project_tracemini_schedules(project_id,configured_by,name,frequency,local_time,timezone,selected_days,reporter,format,prompt,include_diff,documents,notify_slack,next_run_at,dedupe_key,enabled) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) on conflict(project_id) do update set configured_by=excluded.configured_by,name=excluded.name,frequency=excluded.frequency,local_time=excluded.local_time,timezone=excluded.timezone,selected_days=excluded.selected_days,reporter=excluded.reporter,format=excluded.format,prompt=excluded.prompt,include_diff=excluded.include_diff,documents=excluded.documents,notify_slack=excluded.notify_slack,next_run_at=excluded.next_run_at,dedupe_key=excluded.dedupe_key,enabled=excluded.enabled,updated_at=now() returning *`, [project, session.id, name, frequency, time, timezone, JSON.stringify(days), reporter, format, schedulePrompt, input.includeDiff === true, JSON.stringify(scheduleDocuments), input.notifySlack === true && Boolean(process.env.SLACK_REPORT_WEBHOOK_URL), next, dedupe, input.enabled !== false]);
  return result.rows[0];
}

function computeNextSchedule(frequency: string, localTime: string, timezone: string, selectedDays: number[]): string {
  const [hour, minute] = localTime.split(':').map(Number); const allowed = new Set(frequency === 'weekdays' ? [1,2,3,4,5] : frequency === 'selected_days' ? selectedDays : [0,1,2,3,4,5,6]);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' });
  for (let offset = 1; offset <= 370 * 1440; offset++) { const candidate = new Date(Date.now() + offset * 60_000); const parts = formatter.formatToParts(candidate); const h = Number(parts.find((p) => p.type === 'hour')?.value); const m = Number(parts.find((p) => p.type === 'minute')?.value); const weekday = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value || ''); if (h === hour && m === minute && allowed.has(weekday)) return candidate.toISOString(); }
  throw new ProjectServiceError('could not materialize schedule in timezone', 400, 'invalid_request');
}

function cryptoHash(value: string) { return crypto.createHash('sha256').update(value).digest('hex'); }
