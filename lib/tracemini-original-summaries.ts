import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { safeReportText, safeGitWorkText } from './tracemini-work-evidence';

/** DB-only accepted-event scheduling. The existing node poll/context/original CLI
 * prompt/generate/complete path does all inference after ingestion commits. */
export async function scheduleOriginalSummaries(db: PoolClient, project: string, eventIds: Array<string|number>) {
  if (process.env.ENGINEER_JOURNAL_WRITES_DISABLED === '1' || !eventIds.length) return 0;
  if (eventIds.length > 250) throw new Error('Journal batch exceeds ingestion limit');
  // Embedded-only installations may not have installed the optional node schema.
  // No executable consumer means no automatic work, not failed source ingestion.
  if (!(await db.query("select to_regclass('tracemini_node_devices') as node_table")).rows[0]?.node_table) return 0;
  await db.query(`select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2,0))`,[project,'engineers.md']);
  const scopes=(await db.query(`select d.user_id,d.id as device_id,r.id as root_id,min(e.occurred_at)::date::text as start_day,max(e.occurred_at)::date::text as end_day,max(e.id) as event_id
    from project_tracemini_events e join project_tracemini_roots r on r.id=e.root_id and r.project_id=e.project_id and r.device_id=e.device_id and r.status='approved' and r.revoked_at is null
    join files_agent_devices d on d.id=e.device_id and d.revoked_at is null
    join tracemini_node_devices n on n.id=d.node_device_id and n.user_id=d.user_id and n.company_id=d.company_id and n.capability='node-git-v1' and n.revoked_at is null and n.expires_at>now()
    join app_users u on u.id=d.user_id and u.approval_status='approved'
    join projects p on p.id=e.project_id and p.approval_status='approved'
    where e.project_id=$1 and e.id=any($2::bigint[])
    and (select count(*) from project_tracemini_roots rr where rr.project_id=r.project_id and rr.device_id=d.id and rr.status='approved' and rr.revoked_at is null)=1
    and (p.client_id=u.id or exists(select 1 from project_memberships m where m.project_id=p.id and m.user_id=u.id and m.membership_status='active'))
    group by d.user_id,d.id,r.id`,[project,eventIds])).rows;
  for(const s of scopes) {
    const pending=(await db.query(`select id from project_tracemini_reports where project_id=$1 and target_user_id=$2 and target_device_id=$3 and target_root_id=$4 and dedupe_key like 'automatic-original:%' and status='pending' and attempt_count<10 order by id desc limit 1 for update skip locked`,[project,s.user_id,s.device_id,s.root_id])).rows[0];
    if(pending) await db.query(`update project_tracemini_reports set start_date=least(start_date,$2::date),end_date=greatest(end_date,$3::date) where id=$1`,[pending.id,s.start_day,s.end_day]);
    else await db.query(`insert into project_tracemini_reports(project_id,requested_by,target_user_id,target_device_id,target_root_id,scope,reporter,name,format,prompt,start_date,end_date,include_diff,documents,status,dedupe_key,notify_slack,slack_status,next_run_at)
      values($1,$2,$2,$3,$4,'personal','codex','Automatic Neo-Nexus summary','markdown','Summarize the selected repository using concise evidence-backed bullets. Preserve occurrence dates and disclose missing evidence.',$5,$6,false,'[]'::jsonb,'pending',$7,false,'not_requested',now()+interval '15 seconds') on conflict(dedupe_key) do nothing`,[project,s.user_id,s.device_id,s.root_id,s.start_day,s.end_day,`automatic-original:${project}:${s.root_id}:${s.event_id}`]);
  }
  return scopes.length;
}

/** Caller holds successful completion's authorization transaction. Historical
 * maintenance can call this idempotently with explicitly resolved source binding. */
export async function saveOriginalTraceMiniSummary(db: PoolClient, reportId: string, collector: string, root: string|null, device: string|null) {
  if(process.env.ENGINEER_JOURNAL_WRITES_DISABLED === '1') return false;
  const r=(await db.query(`select *,start_date::text as start_day,end_date::text as end_day from project_tracemini_reports where id=$1 and status='completed'`,[reportId])).rows[0];
  if(!r || (r.scope==='workspace' && String(r.target_user_id)!==collector) || (r.scope==='personal' && String(r.requested_by)!==collector)) return false;
  const markdown=safeReportText(r.markdown); if(!markdown) return false;
  await db.query(`select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2,0))`,[String(r.project_id),'engineers.md']);
  const inserted=await db.query(`insert into project_tracemini_original_summaries(report_id,project_id,collector_user_id,root_id,device_id,start_date,end_date,source_created_at,markdown) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(report_id) do nothing returning report_id`,[r.id,r.project_id,collector,root,device,r.start_day,r.end_day,r.created_at,markdown]);
  if(!inserted.rowCount)return false;
  const rows=await readOriginalTraceMiniSummaries(db,String(r.project_id),null);
  const previous=(await db.query(`select h.file_id,h.current_version,v.content from project_file_heads h join project_files v on v.project_id=h.project_id and v.file_id=h.file_id and v.version=h.current_version where h.project_id=$1 and h.path='engineers.md' and h.deleted_at is null for update of h`,[r.project_id])).rows[0];
  const section=`<!-- automatic-engineer-journal:start -->\n## Neo-Nexus summaries\n\n${rows.map(formatOriginalSummary).join('\n\n')}\n<!-- automatic-engineer-journal:end -->\n`;
  const prefix=previous?String(previous.content).replace(/<!-- automatic-engineer-journal:start -->[\s\S]*?<!-- automatic-engineer-journal:end -->\n?/g,'').trimEnd():'# Engineers';
  let content=`${prefix}\n\n${section}`;
  if(Buffer.byteLength(content)>262144)content=`# Engineers\n\nEarlier human content remains in the previous immutable file version.\n\n${section}`;
  if(previous?.content===content)return true;
  const file=previous?.file_id||crypto.randomUUID(),version=previous?Number(previous.current_version)+1:1;
  const bytes=Buffer.byteLength(content),sha=crypto.createHash('sha256').update(content).digest('hex');
  await db.query(`insert into project_files(project_id,file_id,version,path,media_type,content,byte_size,sha256,created_by) values($1,$2,$3,'engineers.md','text/markdown',$4,$5,$6,$7)`,[r.project_id,file,version,content,bytes,sha,collector]);
  await db.query(`insert into project_file_heads(project_id,file_id,current_version,path,media_type,byte_size,sha256) values($1,$2,$3,'engineers.md','text/markdown',$4,$5) on conflict(project_id,file_id) do update set current_version=excluded.current_version,byte_size=excluded.byte_size,sha256=excluded.sha256,updated_at=now()`,[r.project_id,file,version,bytes,sha]);
  await db.query(`insert into project_engineer_journal_files(project_id,file_id) values($1,$2) on conflict do nothing`,[r.project_id,file]);
  return true;
}
export async function readOriginalTraceMiniSummaries(db: Pick<PoolClient,'query'>,project:string,collector:string|null,start?:string,end?:string) {
  // Internal reader: caller MUST hold project authorization and manager/self gate.
  return (await db.query(`select * from (select distinct on (s.collector_user_id,s.root_id) s.*,s.start_date::text as start_day,s.end_date::text as end_day,u.display_name,
    exists(select 1 from project_tracemini_reports failed where failed.project_id=s.project_id and failed.requested_by=s.collector_user_id and failed.dedupe_key like 'automatic-original:%' and failed.status='failed' and failed.created_at>s.source_created_at) as refresh_exhausted
    from project_tracemini_original_summaries s join app_users u on u.id=s.collector_user_id
    where s.project_id=$1 and ($2::bigint is null or s.collector_user_id=$2)
    and ($3::date is null or s.end_date >= $3::date) and ($4::date is null or s.start_date <= $4::date)
    order by s.collector_user_id,s.root_id,s.end_date desc,s.source_created_at desc,s.report_id desc) latest
    order by end_date desc,source_created_at desc,report_id desc limit 3`,[project,collector,start||null,end||null])).rows;
}
export function formatOriginalSummary(row: Record<string,any>) {
  const label=(safeGitWorkText(row.display_name,120)||'Project member').replace(/([\\`*_{}[\]<>()!|#])/g,'\\$1');
  return `### ${label} — ${row.start_day} through ${row.end_day} (UTC)\nSource: Neo-Nexus report #${row.report_id}; selected repository collection, not verified authorship.\n\n${row.markdown}${row.refresh_exhausted?'\n\nAutomatic summary retries exhausted; this saved summary may be stale.':''}`;
}
