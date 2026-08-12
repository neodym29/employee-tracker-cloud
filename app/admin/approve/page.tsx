import FilesAgentDownload from '@/app/components/FilesAgentDownload';
import { health, readDashboard } from '@/lib/db';
import { requireAdminSession } from '@/lib/auth';
import ApprovalClient from './ApprovalClient';

export const dynamic = 'force-dynamic';

export default async function AdminApprove() {
  const session = await requireAdminSession();
  const h = health();
  let users: any[] = [];
  let error = '';
  if (h.configured) {
    try { users = (await readDashboard({}, session.company_id)).users; }
    catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
  }
  return (
    <div>
      {!h.configured && <p className="warn">DATABASE_URL is not configured.</p>}
      {error && <p className="bad">Database error: {error}</p>}
      <ApprovalClient users={users} />
      <FilesAgentDownload />
    </div>
  );
}
