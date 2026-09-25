import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { createChat, listChats } from '@/lib/chats';

export async function GET() {
  try { return NextResponse.json({ ok: true, chats: await listChats(await requireApiSession()) }, { headers: { 'cache-control': 'no-store, private' } }); }
  catch (error) { return apiErrorResponse(error); }
}

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const chat = await createChat(await requireApiSession(), await jsonBody(req));
    return NextResponse.json({ ok: true, chat }, { status: 201 });
  } catch (error) { return apiErrorResponse(error); }
}
