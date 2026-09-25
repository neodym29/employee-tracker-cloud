import { NextResponse } from 'next/server';
import { apiErrorResponse, requireApiSession } from '@/lib/api';
import { listChatPeople } from '@/lib/chats';

export async function GET() {
  try { return NextResponse.json({ ok: true, people: await listChatPeople(await requireApiSession()) }, { headers: { 'cache-control': 'no-store, private' } }); }
  catch (error) { return apiErrorResponse(error); }
}
