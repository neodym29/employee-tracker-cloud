import { requirePlatformAdminSession } from '@/lib/auth';
import { listPendingApprovals } from '@/lib/projects';
import ApprovalClient from './ApprovalClient';

export const dynamic = 'force-dynamic';

export default async function AdminApprove() {
  const session = await requirePlatformAdminSession();
  let approvals: Awaited<ReturnType<typeof listPendingApprovals>> = [];
  let unavailable = false;
  try {
    approvals = await listPendingApprovals(session);
  } catch (error) {
    console.error('[admin-approvals] Failed to load pending accounts', error);
    unavailable = true;
  }
  return <ApprovalClient initialApprovals={approvals} unavailable={unavailable} />;
}
