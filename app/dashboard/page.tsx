import { requireApprovedSession } from '@/lib/auth';
import { readFilesAgentDashboard, type FilesAgentDashboardData } from '@/lib/files-agent-dashboard';
import { readProjectDashboard, type ProjectDashboardData } from '@/lib/project-dashboard';
import DashboardClient from './DashboardClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

export default async function Dashboard() {
  const session = await requireApprovedSession();
  const accountType = session.account_type;
  const platformAdmin = session.role === 'admin' && session.account_type === 'admin';
  let error = '';

  if (accountType === 'admin') {
    let data: FilesAgentDashboardData | null = null;
    if (platformAdmin) {
      try {
        data = await readFilesAgentDashboard(session.company_id);
      } catch {
        error = 'Could not load files-agent data.';
      }
    } else {
      error = 'Could not verify platform admin access.';
    }
    return <DashboardClient mode="admin" data={data ? JSON.parse(JSON.stringify(data)) : null} error={error} />;
  }

  let data: ProjectDashboardData | null = null;
  try {
    data = await readProjectDashboard(session);
  } catch {
    error = 'Could not load project dashboard data.';
  }
  return <DashboardClient mode="projects" accountType={accountType} data={data ? JSON.parse(JSON.stringify(data)) : null} error={error} />;
}
