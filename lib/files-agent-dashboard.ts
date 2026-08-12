import { getPool } from './db';
import { privacySafeProjectLabel, type FilesAgentDailySummary } from './files-agent-daily-summary';

export type FilesAgentDashboardDevice = {
  owner: string;
  device: string;
  lastSeenAt: string;
  revokedAt: string | null;
};

export type FilesAgentDashboardEvent = {
  owner: string;
  device: string;
  action: string;
  project: string;
  agent: string;
  capturedAt: string;
};

export type FilesAgentDashboardDailySummary =
  | { status: 'generated'; generatedAt: string; summary: FilesAgentDailySummary }
  | { status: 'not_generated'; generatedAt: null; summary: null };

export type FilesAgentDashboardData = {
  devices: FilesAgentDashboardDevice[];
  events: FilesAgentDashboardEvent[];
  dailySummary: FilesAgentDashboardDailySummary;
};

const APPROVED_AGENTS = "('hermes','codex','claude')";
const APPROVED_ACTIONS = "('open_write','create','write','truncate','mkdir','rmdir','unlink','rename_from','rename_to','link_from','link_to','symlink')";

function ownerAlias(userId: unknown) {
  return `Employee ${String(userId)}`;
}

export async function readFilesAgentDashboard(companyId: string): Promise<FilesAgentDashboardData> {
  if (!/^\d+$/.test(companyId)) throw new Error('company id must be numeric');
  const db = getPool();
  const [devicesResult, eventsResult, summaryResult] = await Promise.all([
    db.query(
      `select d.id,d.user_id,d.last_seen_at,d.revoked_at
         from files_agent_devices d
        where d.company_id=$1
        order by d.revoked_at nulls first,d.last_seen_at desc,d.id desc`,
      [companyId],
    ),
    db.query(
      `select e.user_id,e.device_id,e.action,e.path,e.payload->>'agent' as agent,e.captured_at
         from files_agent_events e
         join files_agent_devices d on d.id=e.device_id and d.company_id=e.company_id and d.user_id=e.user_id
        where e.company_id=$1
          and e.payload->>'agent' in ${APPROVED_AGENTS}
          and e.action in ${APPROVED_ACTIONS}
        order by e.captured_at desc,e.id desc
        limit 500`,
      [companyId],
    ),
    db.query(
      `select summary,generated_at
         from files_agent_daily_summaries
        where company_id=$1
        order by summary_date desc
        limit 1`,
      [companyId],
    ),
  ]);

  // Aliases preserve device attribution while preventing labels, hostnames, versions, and IDs
  // from crossing the server/browser boundary.
  const deviceAliases = new Map<string, string>();
  for (const row of devicesResult.rows) {
    deviceAliases.set(String(row.id), `Device ${deviceAliases.size + 1}`);
  }
  const deviceAlias = (id: unknown) => deviceAliases.get(String(id)) || 'Other device';

  const stored = summaryResult.rows[0];
  const dailySummary: FilesAgentDashboardDailySummary = stored?.summary
    ? {
      status: 'generated',
      generatedAt: new Date(stored.generated_at).toISOString(),
      summary: stored.summary as FilesAgentDailySummary,
    }
    : { status: 'not_generated', generatedAt: null, summary: null };

  return {
    devices: devicesResult.rows.map((row) => ({
      owner: ownerAlias(row.user_id),
      device: deviceAlias(row.id),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    })),
    events: eventsResult.rows.map((row) => ({
      owner: ownerAlias(row.user_id),
      device: deviceAlias(row.device_id),
      action: String(row.action),
      project: privacySafeProjectLabel(String(row.path)),
      agent: String(row.agent),
      capturedAt: new Date(row.captured_at).toISOString(),
    })),
    dailySummary,
  };
}
