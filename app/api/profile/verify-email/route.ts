import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requireApiSession } from '@/lib/api';
import { confirmOwnEmailVerification, sendOwnEmailVerification } from '@/lib/account-security';

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireApiSession();
    const result = await sendOwnEmailVerification(session);
    return NextResponse.json({ ok: true, ...result }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) { return apiErrorResponse(error); }
}

export async function PATCH(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requireApiSession();
    const body = await jsonBody(req);
    await confirmOwnEmailVerification(session, body.token);
    return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) { return apiErrorResponse(error); }
}
