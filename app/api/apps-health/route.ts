import { NextResponse } from 'next/server';
import { applicationCatalog } from '@/lib/app-catalog';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const checkedAt = new Date().toISOString();
  const apps = await Promise.all(applicationCatalog.map(async (app) => {
    const startedAt = Date.now();
    try {
      const response = await fetch(app.url, {
        cache: 'no-store',
        redirect: 'follow',
        signal: AbortSignal.timeout(7_000),
        headers: { 'User-Agent': 'Neo-Nexus application health check' },
      });
      return {
        id: app.id,
        online: response.status < 500,
        latencyMs: Date.now() - startedAt,
      };
    } catch {
      return { id: app.id, online: false, latencyMs: null };
    }
  }));

  return NextResponse.json({ checkedAt, apps }, { headers: { 'Cache-Control': 'no-store' } });
}
