import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, assertSameOrigin, jsonBody, requirePlatformAdminApiSession } from '@/lib/api';
import { createApprovedAccount } from '@/lib/projects';

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await requirePlatformAdminApiSession();
    const body = await jsonBody(req);
    return NextResponse.json({ ok: true, account: await createApprovedAccount(session, body) }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
