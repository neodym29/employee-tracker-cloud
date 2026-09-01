import crypto from 'node:crypto';

export const CANONICAL_PROJECT_AGENT_PATHS = [
  'engineers.md',
  'clients.md',
  'progress-reports/latest.md',
  'statistics.md',
] as const;

export type ProjectAgentMember = {
  user_id: string | number;
  display_name: string;
  account_type: 'client' | 'engineer';
  membership_type: string;
};

export type ProjectAgentStatistics = {
  activeMembers: number;
  activeEngineers: number;
  clients: number;
  generatedDocuments: number;
  records: number;
  artifacts: number;
};

type Queryable = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, any>> }> };
type ProjectData = { id: string | number; title: unknown; description?: unknown; status?: unknown };

const safeText = (value: unknown, fallback: string) => String(value ?? fallback)
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/([\\`*_[\]<>|])/g, '\\$1')
  .trim()
  .slice(0, 4000) || fallback;

const count = (value: unknown) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, 1_000_000_000) : 0;
};

export function buildCanonicalProjectDocuments(
  project: ProjectData,
  authorizedMembers: ProjectAgentMember[],
  aggregateStatistics: ProjectAgentStatistics,
) {
  const title = safeText(project.title, 'Untitled project');
  const description = safeText(project.description, 'No project description has been provided.');
  const status = safeText(project.status, 'unknown');
  const members = authorizedMembers.slice(0, 50);
  const engineers = members.filter((member) => member.account_type === 'engineer');
  const clients = members.filter((member) => member.account_type === 'client');
  const roster = (items: ProjectAgentMember[], empty: string) => items.length
    ? items.map((member) => `- ${safeText(member.display_name, 'Unnamed member')} — ${safeText(member.membership_type, 'active')}`).join('\n')
    : `- ${empty}`;

  return [
    {
      path: 'engineers.md', mediaType: 'text/markdown',
      content: `# Engineers\n\nProject: **${title}**\n\n${roster(engineers, 'No active approved engineers are assigned.')}\n`,
    },
    {
      path: 'clients.md', mediaType: 'text/markdown',
      content: `# Clients\n\nProject: **${title}**\n\n${roster(clients, 'No active approved client is recorded.')}\n`,
    },
    {
      path: 'progress-reports/latest.md', mediaType: 'text/markdown',
      content: `# Latest progress report\n\n## Project\n\n**${title}**\n\n${description}\n\n## Current state\n\n- Status: ${status}\n- Active members: ${count(aggregateStatistics.activeMembers)}\n\n## Next update\n\nThe project agent maintains this report from authorized project activity when relevant.\n`,
    },
    {
      path: 'statistics.md', mediaType: 'text/markdown',
      content: `# Project statistics\n\nProject: **${title}**\n\n- Active members: ${count(aggregateStatistics.activeMembers)}\n- Active engineers: ${count(aggregateStatistics.activeEngineers)}\n- Clients: ${count(aggregateStatistics.clients)}\n- Generated documents: ${count(aggregateStatistics.generatedDocuments)}\n- Records: ${count(aggregateStatistics.records)}\n- Artifacts: ${count(aggregateStatistics.artifacts)}\n`,
    },
  ];
}

/** Loads only the approved active roster and bounded aggregate counts used by agent outputs/context. */
export async function loadProjectAgentStructuredData(db: Queryable, projectId: string) {
  const [memberResult, statisticsResult] = await Promise.all([
    db.query(
      `select roster.user_id,roster.display_name,roster.account_type,roster.membership_type from (
         select u.id as user_id,u.display_name,u.account_type,'owner'::text as membership_type,0 as sort_order
           from projects p join app_users u on u.id=p.client_id and u.account_type='client' and u.approval_status='approved'
          where p.id=$1
         union all
         select u.id,u.display_name,u.account_type,pm.membership_type,1
           from project_memberships pm join app_users u on u.id=pm.user_id and u.approval_status='approved'
          where pm.project_id=$1 and pm.membership_status='active'
       ) roster order by roster.sort_order,roster.display_name,roster.user_id limit 50`,
      [projectId],
    ),
    db.query(
      `select
         (select count(*) from project_memberships pm where pm.project_id=$1 and pm.membership_status='active') + 1 as active_members,
         (select count(*) from project_memberships pm join app_users u on u.id=pm.user_id and u.account_type='engineer' and u.approval_status='approved' where pm.project_id=$1 and pm.membership_status='active') as active_engineers,
         1 as clients,
         (select count(*) from project_file_heads h where h.project_id=$1 and h.deleted_at is null) as generated_documents,
         (select count(*) from project_records r where r.project_id=$1) as records,
         (select count(*) from project_artifacts a where a.project_id=$1) as artifacts`,
      [projectId],
    ),
  ]);
  const row = statisticsResult.rows[0] || {};
  return {
    memberRoster: memberResult.rows as ProjectAgentMember[],
    projectStatistics: {
      activeMembers: count(row.active_members),
      activeEngineers: count(row.active_engineers),
      clients: count(row.clients),
      generatedDocuments: count(row.generated_documents),
      records: count(row.records),
      artifacts: count(row.artifacts),
    } as ProjectAgentStatistics,
  };
}

/** Idempotently seeds missing agent outputs; existing live paths and all versions remain untouched. */
export async function ensureCanonicalProjectDocuments(
  db: Queryable,
  project: ProjectData,
  authorizedMembers: ProjectAgentMember[],
  aggregateStatistics: ProjectAgentStatistics,
  createdBy: string,
) {
  const createdPaths: string[] = [];
  const existingPaths: string[] = [];
  const missingPaths: string[] = [];

  for (const path of CANONICAL_PROJECT_AGENT_PATHS) {
    await db.query(`select pg_advisory_xact_lock(hashtextextended($1 || ':' || $2,0))`, [String(project.id), path]);
    const existing = await db.query(
      `select file_id from project_file_heads where project_id=$1 and path=$2 and deleted_at is null limit 1`,
      [String(project.id), path],
    );
    if (existing.rows[0]) existingPaths.push(path);
    else missingPaths.push(path);
  }

  const projectedStatistics = {
    ...aggregateStatistics,
    generatedDocuments: count(aggregateStatistics.generatedDocuments) + missingPaths.length,
  };
  const documentsByPath = new Map(
    buildCanonicalProjectDocuments(project, authorizedMembers, projectedStatistics)
      .map((document) => [document.path, document]),
  );

  for (const path of missingPaths) {
    const document = documentsByPath.get(path);
    if (!document) throw new Error(`Missing canonical document definition: ${path}`);
    const fileId = crypto.randomUUID();
    const digest = crypto.createHash('sha256').update(document.content, 'utf8').digest('hex');
    const byteSize = Buffer.byteLength(document.content, 'utf8');
    await db.query(
      `insert into project_files(project_id,file_id,version,path,media_type,content,byte_size,sha256,created_by)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [String(project.id), fileId, 1, document.path, document.mediaType, document.content, byteSize, digest, createdBy],
    );
    await db.query(
      `insert into project_file_heads(project_id,file_id,current_version,path,media_type,byte_size,sha256)
       values($1,$2,$3,$4,$5,$6,$7)`,
      [String(project.id), fileId, 1, document.path, document.mediaType, byteSize, digest],
    );
    createdPaths.push(document.path);
  }
  return { createdPaths, existingPaths };
}
