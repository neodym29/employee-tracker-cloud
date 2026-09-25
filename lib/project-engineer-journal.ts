import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { safeGitWorkText } from './tracemini-work-evidence';

const START = '<!-- automatic-engineer-journal:start -->';
const END = '<!-- automatic-engineer-journal:end -->';
const LATEST = 30;
/** Aggregate journal documents must not bypass the collector-scoped chat reader. */
export async function scopeEngineerJournalFiles(db: Pick<PoolClient, 'query'>, project: string, actor: string, rows: Array<Record<string, any>>) {
  if (!rows.length) return rows;
  const bindings = (await db.query(`select file_id from project_engineer_journal_files where project_id=$1 and file_id=any($2::text[])`, [project, rows.map(row => String(row.file_id))])).rows;
  const protectedIds = new Set(bindings.map(row => String(row.file_id)));
  if (!protectedIds.size) return rows;
  const manager = (await db.query(`select u.id from app_users u join projects p on p.id=$1 where u.id=$2 and u.approval_status='approved' and ((u.role='admin' and u.account_type='admin') or (u.account_type='client' and p.client_id=u.id))`, [project,actor])).rows[0];
  return manager ? rows : rows.filter(row => !protectedIds.has(String(row.file_id)));
}
const escapeMarkdown = (text: string) => text.replace(/([\\`*_{}[\]<>()!|#])/g, '\\$1');

/** No inference, paths, bodies or arbitrary provenance serialization. Source text is
 * quoted evidence, not a claim that work shipped, tests passed or a person authored it. */
export function summarizeEngineerEvent(event: Record<string, unknown>): string {
  const p = event.provenance && typeof event.provenance === 'object' && !Array.isArray(event.provenance)
    ? event.provenance as Record<string, unknown> : {};
  const kind = typeof event.kind === 'string' ? event.kind : '';
  const fileActivity = ['file_activity', 'non_git', 'dirty'].includes(kind);
  const agent = ['hermes', 'codex', 'claude'].includes(String(event.agent)) ? String(event.agent) : 'approved agent';
  const label = fileActivity
    ? event.evidence_eligible === true ? `Approved AI file activity (${agent})` : 'File activity (AI attribution unverified)'
    : ({commit:'Commit recorded',stage:'Staged changes recorded',branch:'Branch change recorded',merge:'Merge recorded',rewrite:'History rewrite recorded',pull:'Pull recorded',push:'Push recorded'} as Record<string,string>)[kind] || 'Repository activity recorded';
  const sha = typeof p.head_sha === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(p.head_sha) ? p.head_sha.slice(0,12) : undefined;
  const subject = kind === 'commit' && sha ? safeGitWorkText(p.commit_subject,600) : undefined;
  return `${event.action === 'commit_history' ? 'Imported history. ' : ''}${label}. ${subject ? `Commit subject: “${escapeMarkdown(subject)}”. Source description; not verified completion.` : 'No safe descriptive evidence was captured; intent and completion are unknown.'}`;
}

/** Internal ingestion/backfill primitive. Caller MUST hold the authorized source
 * ingestion transaction (or explicitly authorized maintenance transaction). No pool
 * acquisition/network work. Journal + file + event commit together; DB failures
 * deliberately roll back so normal durable ingestion retry repairs all three. */
// The former synthetic event projection is retained only as inactive legacy code.
export { scheduleOriginalSummaries as saveAcceptedEngineerEvents } from './tracemini-original-summaries';
async function legacySyntheticEventProjection(db: PoolClient, project: string, eventIds: Array<string | number>) {
  // Rollback mode disables only this derived write; durable read/mutation guards
  // remain unconditional and source ingestion continues normally. Zero means saved zero.
  if (process.env.ENGINEER_JOURNAL_WRITES_DISABLED === '1') return 0;
  if (!eventIds.length) return 0;
  if (eventIds.length > 250) throw new Error('Journal batch exceeds ingestion limit');
  // Same lock as canonical seeding/file-path operations; serialize projections,
  // including concurrent different events, before reading journal/file state.
  await db.query(`select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2,0))`, [project,'engineers.md']);
  const events = (await db.query(`select e.id,e.kind,e.action,e.agent,e.evidence_eligible,e.provenance,e.root_id,e.occurred_at,e.created_at,d.user_id
    from project_tracemini_events e
    join project_tracemini_roots r on r.id=e.root_id and r.project_id=e.project_id and r.device_id=e.device_id and r.status='approved' and r.revoked_at is null
    join files_agent_devices d on d.id=e.device_id and d.revoked_at is null
    join app_users u on u.id=d.user_id and u.approval_status='approved'
    join projects p on p.id=e.project_id and p.approval_status='approved'
    where e.project_id=$1 and e.id=any($2::bigint[])
      and (p.client_id=u.id or exists(select 1 from project_memberships m where m.project_id=p.id and m.user_id=u.id and m.membership_status='active'))
    order by e.id`, [project,eventIds])).rows;
  let saved = 0;
  for (const event of events) {
    // Future optional text enrichment must remain failure-contained; even malformed
    // legacy evidence gets a truthful fallback, never lost ingestion or a model job.
    let summary: string;
    try { summary = summarizeEngineerEvent(event); }
    catch { summary = 'Repository activity recorded. Descriptive evidence unavailable; intent and completion are unknown.'; }
    const result = await db.query(`insert into project_engineer_journal(event_id,project_id,collector_user_id,root_id,occurred_at,ingested_at,summary)
      values($1,$2,$3,$4,$5,$6,$7) on conflict(event_id) do nothing returning event_id`,
    [event.id,project,event.user_id,event.root_id,event.occurred_at,event.created_at,summary]);
    saved += result.rowCount || 0;
  }
  if (!saved) return 0;
  const latest = (await db.query(`select j.event_id,j.collector_user_id,j.root_id,j.occurred_at,j.ingested_at,j.summary,u.display_name,count(*) over() as total
    from project_engineer_journal j join app_users u on u.id=j.collector_user_id where j.project_id=$1 order by j.occurred_at desc,j.event_id desc limit ${LATEST}`, [project])).rows;
  const previous = (await db.query(`select h.file_id,h.current_version,v.content from project_file_heads h
    join project_files v on v.project_id=h.project_id and v.file_id=h.file_id and v.version=h.current_version
    where h.project_id=$1 and h.path='engineers.md' and h.deleted_at is null for update of h`, [project])).rows[0];
  const fileId = previous?.file_id || crypto.randomUUID();
  const version = previous ? Number(previous.current_version) + 1 : 1;
  const section = `${START}\n## Automatically saved engineer updates\n\nLatest ${latest.length} of ${latest[0].total} saved events, ordered by occurrence (UTC). Older entries remain in the durable journal and file history. Names identify collecting engineers, not verified Git authors. No delivery/progress inference.\n\n${latest.map(row => `- ${new Date(row.occurred_at).toISOString().slice(0,10)} — ${escapeMarkdown(safeGitWorkText(row.display_name,120) || 'Project member')}: ${row.summary}`).join('\n')}\n\nCapture coverage: authorized selected-repository events only. Unobserved saves and unsupported AI tool paths are not included; absence is not evidence of no work.\n${END}\n`;
  const prefix = previous ? String(previous.content).replace(/<!-- automatic-engineer-journal:start -->[\s\S]*?<!-- automatic-engineer-journal:end -->\n?/g,'').trimEnd() : '# Engineers';
  let content = `${prefix}\n\n${section}`;
  // Preserve oversized pre-existing content in its immutable prior version rather
  // than rejecting an authorized source event or truncating text mid-character.
  if (Buffer.byteLength(content,'utf8') > 262144) content = `# Engineers\n\nPrevious document content is preserved in file ${fileId}, version ${previous.current_version}; too large to combine with this journal view.\n\n${section}`;
  const bytes = Buffer.byteLength(content,'utf8');
  const sha = crypto.createHash('sha256').update(content,'utf8').digest('hex');
  await db.query(`insert into project_files(project_id,file_id,version,path,media_type,content,byte_size,sha256,created_by)
    values($1,$2,$3,'engineers.md','text/markdown',$4,$5,$6,$7)`, [project,fileId,version,content,bytes,sha,events[0].user_id]);
  await db.query(`insert into project_file_heads(project_id,file_id,current_version,path,media_type,byte_size,sha256)
    values($1,$2,$3,'engineers.md','text/markdown',$4,$5)
    on conflict(project_id,file_id) do update set current_version=excluded.current_version,media_type=excluded.media_type,byte_size=excluded.byte_size,sha256=excluded.sha256,updated_at=now()`, [project,fileId,version,bytes,sha]);
  await db.query(`insert into project_engineer_journal_files(project_id,file_id) values($1,$2) on conflict do nothing`, [project,fileId]);
  return saved;
}
