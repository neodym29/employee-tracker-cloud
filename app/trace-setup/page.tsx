import type { Metadata } from 'next';
import { requireApprovedSession } from '@/lib/auth';
import DesktopCliConnection from '@/app/components/DesktopCliConnection';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Set up Trace CLI | Trace' };

export default async function TraceSetupPage() {
  await requireApprovedSession();
  return <div className="dashboardShell">
    <div className="dashboardHeading"><div><span className="pill">Account setup</span><h1>Set up Trace CLI</h1><p>Connect your device, discover repositories, and link them to existing projects. Project creation works independently of CLI setup.</p><a className="secondaryButton" href="/projects">Back to projects</a></div></div>
    <DesktopCliConnection />
  </div>;
}
