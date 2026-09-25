import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { getVisibleProfile, updateOwnProfile } from '@/lib/profiles';

export async function GET() {
  try {
    const session = await requireApiSession();
    return NextResponse.json({ ok: true, profile: await getVisibleProfile(session, session.id) }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) { return apiErrorResponse(error); }
}

export async function PATCH(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireApiSession();
    return NextResponse.json({ ok: true, profile: await updateOwnProfile(session, await jsonBody(req)) }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) { return apiErrorResponse(error); }
}
