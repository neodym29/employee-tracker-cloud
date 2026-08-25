import { NextRequest, NextResponse } from 'next/server';
import { approveEmployee, health } from '@/lib/db';
import { currentSession } from '@/lib/auth';
import { apiErrorResponse, assertSameOrigin, jsonBody } from '@/lib/api';

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const session = await currentSession();
    if (!session || session.role !== 'admin') {
      return NextResponse.json({ ok: false, error: 'admin login required' }, { status: 403 });
    }
    if (!health().configured) return NextResponse.json({ ok: false, error: 'Service unavailable' }, { status: 503 });
    const body = await jsonBody(req);
    const result = await approveEmployee(String(body.email || ''), session.company_id);
    return NextResponse.json({ ok: true, email: result.email, approval_status: 'approved' });
  } catch (error) {
    if (error instanceof Error && ['Enter a valid work email', 'Employee not found'].includes(error.message)) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    return apiErrorResponse(error);
  }
}
