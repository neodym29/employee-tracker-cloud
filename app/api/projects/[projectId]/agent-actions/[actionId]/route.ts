import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { cancelProjectAgentAction, confirmProjectAgentAction } from '@/lib/project-chat';

type Context = { params: Promise<{ projectId: string; actionId: string }> };

/** Compatibility operation endpoint; dedicated /confirm and /cancel endpoints are also provided. */
export async function POST(req: NextRequest, context: Context) {
  try {
    assertSameOrigin(req);
    const { projectId, actionId } = await context.params;
    const body = await jsonBody(req);
    const session = await requireApiSession();
    if (body.operation === 'confirm') return NextResponse.json({ ok: true, action: await confirmProjectAgentAction(session, projectId, actionId) });
    if (body.operation === 'cancel') return NextResponse.json({ ok: true, action: await cancelProjectAgentAction(session, projectId, actionId) });
    return NextResponse.json({ ok: false, error: 'Invalid action operation', code: 'invalid_request' }, { status: 400 });
  } catch (error) { return apiErrorResponse(error); }
}
