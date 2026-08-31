import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, requireApiSession } from '@/lib/api';
import { confirmProjectAgentAction } from '@/lib/project-chat';
import { toPublicAgentAction } from '@/lib/project-chat-dto';

type Context = { params: Promise<{ projectId: string; actionId: string }> };
export async function POST(req: NextRequest, context: Context) {
  try {
    assertSameOrigin(req);
    const { projectId, actionId } = await context.params;
    const action = await confirmProjectAgentAction(await requireApiSession(), projectId, actionId);
    return NextResponse.json({ ok: true, action: toPublicAgentAction(action) });
  } catch (error) { return apiErrorResponse(error); }
}
