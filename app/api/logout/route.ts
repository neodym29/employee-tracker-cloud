import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/auth';

export async function POST(req: NextRequest) {
  await clearSessionCookie();
  const next = req.nextUrl.searchParams.get('next');
  const destination = next === '/login' ? '/login' : '/';
  return NextResponse.redirect(new URL(destination, req.url), 303);
}
