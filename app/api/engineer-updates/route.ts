import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, requireApiSession } from '@/lib/api';
import { listClientEngineerUpdates } from '@/lib/engineer-updates';

export async function GET(request: NextRequest) {
  try {
    const session = await requireApiSession();
    const projectId = request.nextUrl.searchParams.get('projectId') || undefined;
    const engineerUpdates = await listClientEngineerUpdates(session, projectId);
    return NextResponse.json({ ok: true, engineerUpdates }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
