import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { promoteGroupAdmin } from '@/lib/chats';

type Context = { params: Promise<{ conversationId: string }> };

export async function POST(req: NextRequest, context: Context) {
  try {
    assertSameOrigin(req);
    const { conversationId } = await context.params;
    const input = await jsonBody(req);
    const admin = await promoteGroupAdmin(await requireApiSession(), conversationId, input.userId);
    return NextResponse.json({ ok: true, admin });
  } catch (error) { return apiErrorResponse(error); }
}
