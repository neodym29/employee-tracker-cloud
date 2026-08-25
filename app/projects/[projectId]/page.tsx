import { requireApprovedSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import WorkspaceClient from './WorkspaceClient';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ projectId: string }> };
export default async function ProjectWorkspacePage({ params }: Props) {
  const session = await requireApprovedSession();
  if (session.account_type === 'admin') redirect('/admin/approve');
  const { projectId } = await params;
  return <WorkspaceClient projectId={projectId} accountType={session.account_type} />;
}
