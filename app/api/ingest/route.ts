import { NextResponse } from 'next/server';

const gone = () => NextResponse.json(
  { ok: false, error: 'Legacy tracker ingest has been retired. Use /api/files-agent/ingest.' },
  { status: 410, headers: { 'cache-control': 'no-store' } },
);

export const POST = gone;
export const GET = gone;
export const OPTIONS = gone;
