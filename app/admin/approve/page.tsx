import { health, readDashboard } from '@/lib/db';
import { requireAdminSession } from '@/lib/auth';
import ApprovalClient from './ApprovalClient';

export const dynamic = 'force-dynamic';

const demo = {
  users: [] as any[],
};

export default async function AdminApprove() {
  await requireAdminSession();
  const h = health();
  let users = demo.users;
  let error = '';
  if (h.configured) {
    try {
      const data = await readDashboard();
      users = data.users;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <div>
      {!h.configured && <p className="warn">DATABASE_URL is not configured yet, so this page is showing demo signup data.</p>}
      {error && <p className="bad">Database error: {error}</p>}
      <ApprovalClient users={users} />
    </div>
  );
}
