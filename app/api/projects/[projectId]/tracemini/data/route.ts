import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, requireApiSession } from '@/lib/api';
import { getTraceMiniData } from '@/lib/tracemini';

type Context = { params: Promise<{ projectId: string }> };

export async function GET(_request: NextRequest, context: Context) {
  try {
    const { projectId } = await context.params;
    return NextResponse.json({ ok: true, tracemini: await getTraceMiniData(await requireApiSession(), projectId) }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) { return apiErrorResponse(error); }
}
