import { NextResponse } from 'next/server';

const gone = () => NextResponse.json(
  { ok: false, error: 'Screenshot collection and viewing have been permanently retired.' },
  { status: 410, headers: { 'cache-control': 'no-store' } },
);

export const GET = gone;
export const POST = gone;
export const OPTIONS = gone;
