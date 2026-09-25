import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { listClientRequests, markClientRequestsRead } from '@/lib/client-requests';
import { ProjectServiceError } from '@/lib/projects';

type Context = { params: Promise<{ projectId: string }> };

export async function GET(_req: NextRequest, context: Context) {
  try {
    const { projectId } = await context.params;
    return NextResponse.json(
      { ok: true, requests: await listClientRequests(await requireApiSession(), projectId) },
      { headers: { 'cache-control': 'no-store, private' } },
    );
  } catch (error) { return apiErrorResponse(error); }
}

export async function POST(req: NextRequest, context: Context) {
  try {
    assertSameOrigin(req);
    const { projectId } = await context.params;
    const body = await jsonBody(req);
    if (body.action !== 'mark_read') throw new ProjectServiceError('Invalid request action');
    return NextResponse.json({ ok: true, ...(await markClientRequestsRead(await requireApiSession(), projectId)) });
  } catch (error) { return apiErrorResponse(error); }
}
