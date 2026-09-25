import type { Metadata } from 'next';
import { requireApprovedSession } from '@/lib/auth';
import TraceNodeInstall from '@/app/components/trace-node/Install';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Set up Neo-Nexus CLI | Neo-Nexus' };

export default async function TraceSetupPage() {
  const session = await requireApprovedSession();
  return <div className="dashboardShell">
    <div className="dashboardHeading"><div><span className="pill">Account setup</span><h1>Set up Neo-Nexus CLI</h1></div></div>
    <TraceNodeInstall showCodexPlugin={session.account_type === 'engineer'} />
  </div>;
}
