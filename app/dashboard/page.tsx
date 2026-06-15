import { health, readDashboard } from '@/lib/db';
import { requireAdminSession } from '@/lib/auth';
import DashboardClient from './DashboardClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

const demo = {
  companies: [] as any[],
  users: [] as any[],
  devices: [] as any[],
  events: [] as any[],
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function dashboardFilters(searchParams: Record<string, string | string[] | undefined>) {
  const mode = first(searchParams.mode) === 'range' ? 'range' : 'latest';
  return {
    mode,
    user: first(searchParams.user) || 'all',
    eventType: first(searchParams.eventType) || 'all',
    startTime: first(searchParams.start),
    endTime: first(searchParams.end),
  } as const;
}

export default async function Dashboard({ searchParams }: { searchParams: SearchParams }) {
  await requireAdminSession();
  const filters = dashboardFilters(await searchParams);
  const h = health();
  let data = demo;
  let error = '';
  if (h.configured) {
    try { data = await readDashboard(filters); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  const serializableData = JSON.parse(JSON.stringify(data));
  return <DashboardClient data={serializableData} configured={h.configured} error={error} initialFilters={filters} />;
}
