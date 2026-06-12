import { health, readDashboard } from '@/lib/db';
import { requireAdminSession } from '@/lib/auth';
import DashboardClient from './DashboardClient';

export const dynamic = 'force-dynamic';

const demo = {
  companies: [] as any[],
  users: [] as any[],
  devices: [] as any[],
  events: [] as any[],
};

export default async function Dashboard() {
  await requireAdminSession();
  const h = health();
  let data = demo;
  let error = '';
  if (h.configured) {
    try { data = await readDashboard(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  const serializableData = JSON.parse(JSON.stringify(data));
  return <DashboardClient data={serializableData} configured={h.configured} error={error} />;
}
