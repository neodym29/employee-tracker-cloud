import { NextResponse } from 'next/server';
import { apiErrorResponse, requireApiSession } from '@/lib/api';
import { listAvailableClients } from '@/lib/projects';

export async function GET() {
  try {
    const clients = await listAvailableClients(await requireApiSession('engineer'));
    return NextResponse.json({ ok: true, clients }, { headers: { 'cache-control': 'no-store, private' } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
