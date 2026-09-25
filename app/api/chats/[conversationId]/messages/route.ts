import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { listChatMessages, sendChatMessage } from '@/lib/chats';

type Context = { params: Promise<{ conversationId: string }> };

export async function GET(req: NextRequest, context: Context) {
  try {
    const { conversationId } = await context.params;
    const messages = await listChatMessages(await requireApiSession(), conversationId);
    return NextResponse.json({ ok: true, messages }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) { return apiErrorResponse(error); }
}

export async function POST(req: NextRequest, context: Context) {
  try {
    assertSameOrigin(req);
    const { conversationId } = await context.params;
    const message = await sendChatMessage(await requireApiSession(), conversationId, await jsonBody(req));
    return NextResponse.json({ ok: true, message }, { status: 201 });
  } catch (error) { return apiErrorResponse(error); }
}
