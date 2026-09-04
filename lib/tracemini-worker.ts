import { ensureSchema, getPool } from './db';

const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_ERROR_BYTES = 2_000;

export type ReportLease = { id: string; leaseId: string; projectId: string; reporter: 'codex' | 'hermes'; format: 'markdown' | 'pdf' | 'pptx'; prompt: string | null };

function bounded(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max) throw new Error(`${label} exceeds byte bound`);
  return value;
}

export async function claimTraceMiniReport(workerId: string, leaseSeconds = 300): Promise<ReportLease | null> {
  await ensureSchema(); const db = getPool(); const client = await db.connect();
  try {
    await client.query('begin');
    const result = await client.query(`update project_tracemini_reports set status='running',lease_id=$1,lease_expires_at=now()+($2::text||' seconds')::interval,attempt_count=attempt_count+1 where id=(select id from project_tracemini_reports where (status='pending' or (status='running' and lease_expires_at<now())) and (next_run_at is null or next_run_at<=now()) order by created_at for update skip locked limit 1) returning id,project_id,lease_id,reporter,format,prompt`, [workerId, Math.max(30, Math.min(3600, leaseSeconds))]);
    await client.query('commit');
    return result.rows[0] ? { id: String(result.rows[0].id), leaseId: result.rows[0].lease_id, projectId: String(result.rows[0].project_id), reporter: result.rows[0].reporter, format: result.rows[0].format, prompt: result.rows[0].prompt } : null;
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}

export async function heartbeatTraceMiniReport(leaseId: string, workerId: string, leaseSeconds = 300) {
  await ensureSchema(); const result = await getPool().query(`update project_tracemini_reports set lease_expires_at=now()+($3::text||' seconds')::interval where id=$1 and status='running' and lease_id=$2 returning id`, [leaseId, workerId, Math.max(30, Math.min(3600, leaseSeconds))]);
  if (!result.rows[0]) throw new Error('report lease is missing or expired'); return true;
}

export async function completeTraceMiniReport(leaseId: string, workerId: string, output: string) {
  bounded(output, MAX_OUTPUT_BYTES, 'report output'); await ensureSchema();
  const result = await getPool().query(`update project_tracemini_reports set status='completed',markdown=$3,completed_at=now(),lease_id=null,lease_expires_at=null where id=$1 and status='running' and lease_id=$2 returning id`, [leaseId, workerId, output]);
  if (!result.rows[0]) throw new Error('report lease is missing or expired'); return true;
}

export async function failTraceMiniReport(leaseId: string, workerId: string, error: string, retry = true) {
  bounded(error, MAX_ERROR_BYTES, 'report error'); await ensureSchema();
  const result = await getPool().query(`update project_tracemini_reports set status=case when $4 and attempt_count<10 then 'pending' else 'failed' end,last_error=$3,next_run_at=case when $4 and attempt_count<10 then now()+least((2^attempt_count)*interval '1 minute',interval '1 hour') else null end,lease_id=null,lease_expires_at=null where id=$1 and status='running' and lease_id=$2 returning id`, [leaseId, workerId, error, retry]);
  if (!result.rows[0]) throw new Error('report lease is missing or expired'); return true;
}

export async function cancelTraceMiniReport(projectId: string, reportId: string) {
  await ensureSchema(); const result = await getPool().query(`update project_tracemini_reports set status='cancelled',lease_id=null,lease_expires_at=null where id=$1 and project_id=$2 and status in ('pending','running') returning id`, [reportId, projectId]);
  return Boolean(result.rows[0]);
}

export async function materializeDueTraceMiniSchedules(limit = 50) {
  await ensureSchema(); const db = getPool(); const client = await db.connect();
  try { await client.query('begin');
    const due = await client.query(`select * from project_tracemini_schedules where enabled=true and next_run_at<=now() order by next_run_at for update skip locked limit $1`, [Math.max(1, Math.min(limit, 100))]);
    let created = 0;
    for (const schedule of due.rows) {
      const inserted = await client.query(`insert into project_tracemini_reports(project_id,requested_by,scope,reporter,name,format,prompt,start_date,end_date,include_diff,documents,schedule_id,status,dedupe_key,notify_slack,slack_status) values($1,$2,'workspace',$3,$4,$5,$6,current_date-interval '1 day',current_date-interval '1 day',$7,$8,$9,'pending',md5($9::text||':'||$10::text),$11,case when $11 then 'pending' else 'not_requested' end) on conflict(dedupe_key) do nothing returning id`, [schedule.project_id, schedule.configured_by, schedule.reporter, schedule.name, schedule.format, schedule.prompt, schedule.include_diff, schedule.documents, schedule.id, schedule.next_run_at, schedule.notify_slack]);
      created += inserted.rowCount || 0;
      await client.query(`update project_tracemini_schedules set last_run_at=next_run_at,next_run_at=next_run_at+interval '1 day',updated_at=now() where id=$1`, [schedule.id]);
    }
    await client.query('commit'); return { created, examined: due.rows.length };
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}
