import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, requireApiSession } from '@/lib/api';
import { deleteChat } from '@/lib/chats';

type Context = { params: Promise<{ conversationId: string }> };

export async function DELETE(req: NextRequest, context: Context) {
  try {
    assertSameOrigin(req);
    const { conversationId } = await context.params;
    const chat = await deleteChat(await requireApiSession(), conversationId);
    return NextResponse.json({ ok: true, chat });
  } catch (error) { return apiErrorResponse(error); }
}
