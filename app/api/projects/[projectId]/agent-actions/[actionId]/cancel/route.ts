import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, requireApiSession } from '@/lib/api';
import { cancelProjectAgentAction } from '@/lib/project-chat';

type Context = { params: Promise<{ projectId: string; actionId: string }> };
export async function POST(req: NextRequest, context: Context) {
  try {
    assertSameOrigin(req);
    const { projectId, actionId } = await context.params;
    return NextResponse.json({ ok: true, action: await cancelProjectAgentAction(await requireApiSession(), projectId, actionId) });
  } catch (error) { return apiErrorResponse(error); }
}
