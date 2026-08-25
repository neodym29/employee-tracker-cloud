import { NextRequest, NextResponse } from 'next/server';
import { health, signupAccount } from '@/lib/db';
import { apiErrorResponse, assertSameOrigin, jsonBody } from '@/lib/api';

// signupEmployee remains a legacy telemetry-portal compatibility helper in lib/db.ts.
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    if (!health().configured) return NextResponse.json({ ok: false, error: 'Service unavailable' }, { status: 503 });
    const body = await jsonBody(req);
    const accountType = String(body.accountType || '') as 'client' | 'engineer';
    const result = await signupAccount(accountType, String(body.displayName || ''), String(body.email || ''), String(body.password || ''));
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof Error && [
      'Choose client or engineer', 'Display name must be between 1 and 120 characters',
      'Enter a valid work email', 'Password must be at least 8 characters', 'Account could not be created',
    ].includes(error.message)) {
      const status = error.message === 'Account could not be created' ? 409 : 400;
      return NextResponse.json({ ok: false, error: error.message }, { status });
    }
    return apiErrorResponse(error);
  }
}
