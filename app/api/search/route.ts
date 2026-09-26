import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, requireApiSession } from '@/lib/api';
import { searchWork } from '@/lib/work-search';

export async function GET(req: NextRequest) {
  try {
    const result = await searchWork(await requireApiSession(), req.nextUrl.searchParams.get('q'));
    return NextResponse.json({ ok: true, ...result }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) { return apiErrorResponse(error); }
}
