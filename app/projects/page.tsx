import { requireApprovedSession } from '@/lib/auth';
import ProjectsClient from './ProjectsClient';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const session = await requireApprovedSession();
  if (session.account_type === 'admin') return <section className="card"><span className="pill">Platform admin</span><h1>Trace admin</h1><p className="muted">Review new accounts before they enter the project marketplace.</p><a className="primaryButton" href="/admin/approve">Open account approvals</a></section>;
  return <ProjectsClient accountType={session.account_type} />;
}
