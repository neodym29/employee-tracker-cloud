import { requireApprovedSession } from '@/lib/auth';
import { getProject } from '@/lib/projects';
import WorkspaceClient from './WorkspaceClient';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ projectId: string }> };
export default async function ProjectWorkspacePage({ params }: Props) {
  const session = await requireApprovedSession();
  const { projectId } = await params;
  const platformAdmin = session.account_type === 'admin' && session.role === 'admin';
  const project = await getProject(session, projectId, { platformAudit: platformAdmin });
  const canManageTraceMini = platformAdmin
    || (session.account_type === 'client' && String(project.client_id) === String(session.id));
  return <WorkspaceClient projectId={projectId} accountType={session.account_type} canManageTraceMini={canManageTraceMini} />;
}
