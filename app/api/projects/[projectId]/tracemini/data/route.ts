import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, requireApiSession } from '@/lib/api';
import { getTraceMiniData, proposeTraceMiniProgressForProject } from '@/lib/tracemini';

type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: NextRequest, context: Context) {
  try {
    const { projectId } = await context.params;
    const url = new URL(_request.url);
    return NextResponse.json({ ok: true, tracemini: await getTraceMiniData(await requireApiSession(), projectId, { from: url.searchParams.get('from') || undefined, to: url.searchParams.get('to') || undefined }) }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) { return apiErrorResponse(error); }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    assertSameOrigin(request);
    const { projectId } = await context.params;
    const created = await proposeTraceMiniProgressForProject(await requireApiSession(), projectId);
    return NextResponse.json({ ok: true, created }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) { return apiErrorResponse(error); }
}
