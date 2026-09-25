import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { updateClientRequest } from '@/lib/client-requests';

type Context = { params: Promise<{ projectId: string; requestId: string }> };

export async function PATCH(req: NextRequest, context: Context) {
  try {
    assertSameOrigin(req);
    const { projectId, requestId } = await context.params;
    const body = await jsonBody(req);
    return NextResponse.json({
      ok: true,
      request: await updateClientRequest(await requireApiSession(), projectId, requestId, body.status),
    });
  } catch (error) { return apiErrorResponse(error); }
}
