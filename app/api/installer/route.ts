import { NextResponse } from 'next/server';

const gone = () => NextResponse.json(
  { ok: false, error: 'The legacy tracker installer has been retired. Use the files-agent package.' },
  { status: 410, headers: { 'cache-control': 'no-store' } },
);

export const GET = gone;
export const POST = gone;
export const OPTIONS = gone;
