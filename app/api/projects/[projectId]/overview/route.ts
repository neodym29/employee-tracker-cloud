import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, requireApiSession } from '@/lib/api';
import { getProjectOverview } from '@/lib/project-overview';

type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: NextRequest, context: Context) {
  try {
    const { projectId } = await context.params;
    const overview = await getProjectOverview(await requireApiSession(), projectId);
    return NextResponse.json({ ok: true, overview }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
