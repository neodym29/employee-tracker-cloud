import { NextResponse } from 'next/server';
import { apiErrorResponse, requireApiSession } from '@/lib/api';
import { chatNotifications } from '@/lib/chats';
import { recentUnreadClientRequests } from '@/lib/client-requests';

export async function GET() {
  try {
    const session = await requireApiSession();
    const [chats, clientRequests] = await Promise.all([
      chatNotifications(session),
      recentUnreadClientRequests(session),
    ]);
    return NextResponse.json({ ok: true, chats, clientRequests }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) { return apiErrorResponse(error); }
}
