import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { listProjectChat, submitProjectChat } from '@/lib/project-chat';
import { toPublicAgentAction } from '@/lib/project-chat-dto';

type Context = { params: Promise<{ projectId: string }> };

export const maxDuration = 300;

export async function GET(_req: NextRequest, context: Context) {
  try {
    const { projectId } = await context.params;
    const data = await listProjectChat(await requireApiSession(), projectId);
    return NextResponse.json({ ok: true, ...data, actions: data.actions.map(toPublicAgentAction) }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) { return apiErrorResponse(error); }
}

export async function POST(req: NextRequest, context: Context) {
  try {
    assertSameOrigin(req);
    const { projectId } = await context.params;
    const data = await submitProjectChat(await requireApiSession(), projectId, await jsonBody(req));
    return NextResponse.json({ ok: true, ...data, actions: data.actions.map(toPublicAgentAction) }, { status: 201 });
  } catch (error) { return apiErrorResponse(error); }
}
