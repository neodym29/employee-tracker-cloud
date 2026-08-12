import { requireAdminSession } from '@/lib/auth';
import { readFilesAgentDashboard, type FilesAgentDashboardData } from '@/lib/files-agent-dashboard';
import DashboardClient from './DashboardClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

export default async function Dashboard() {
  const session = await requireAdminSession();
  let data: FilesAgentDashboardData | null = null;
  let error = '';
  try {
    data = await readFilesAgentDashboard(session.company_id);
  } catch {
    error = 'Could not load files-agent data.';
  }
  return <DashboardClient data={data ? JSON.parse(JSON.stringify(data)) : null} error={error} />;
}
