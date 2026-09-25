import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { setOwnAppearance } from '@/lib/profiles';

export async function PATCH(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireApiSession();
    const appearance = await setOwnAppearance(session, await jsonBody(req));
    return NextResponse.json({ ok: true, appearance }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) { return apiErrorResponse(error); }
}
