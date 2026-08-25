import { requirePlatformAdminSession } from '@/lib/auth';
import { listPendingApprovals } from '@/lib/projects';
import ApprovalClient from './ApprovalClient';

export const dynamic = 'force-dynamic';

export default async function AdminApprove() {
  const session = await requirePlatformAdminSession();
  let approvals: Awaited<ReturnType<typeof listPendingApprovals>> = [];
  let unavailable = false;
  try { approvals = await listPendingApprovals(session); } catch { unavailable = true; }
  return <ApprovalClient initialApprovals={approvals} unavailable={unavailable} />;
}
