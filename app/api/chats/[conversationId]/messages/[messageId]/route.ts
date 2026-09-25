import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { deleteChatMessage, editChatMessage } from '@/lib/chats';

type Context = { params: Promise<{ conversationId: string; messageId: string }> };

export async function PATCH(req: NextRequest, context: Context) {
  try {
    assertSameOrigin(req);
    const { conversationId, messageId } = await context.params;
    const message = await editChatMessage(await requireApiSession(), conversationId, messageId, await jsonBody(req));
    return NextResponse.json({ ok: true, message });
  } catch (error) { return apiErrorResponse(error); }
}

export async function DELETE(req: NextRequest, context: Context) {
  try {
    assertSameOrigin(req);
    const { conversationId, messageId } = await context.params;
    const message = await deleteChatMessage(await requireApiSession(), conversationId, messageId);
    return NextResponse.json({ ok: true, message });
  } catch (error) { return apiErrorResponse(error); }
}
