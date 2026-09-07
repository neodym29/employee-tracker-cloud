import { NextRequest, NextResponse } from 'next/server';
import { bearerSecret, filesAgentHttpError, FilesAgentError } from '@/lib/files-agent';
import { claimDeviceWork } from '@/lib/tracemini-discovery';

// Kept as a concrete endpoint because the desktop agent addresses selection
// work by candidate id after claiming the device work queue.
export async function POST(request: NextRequest) {
  try {
    const credential = bearerSecret(request);
    if (!credential) throw new FilesAgentError('Bearer device credential required', 401);
    return NextResponse.json({ ok: true, ...(await claimDeviceWork(credential)) }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const failure = filesAgentHttpError(error);
    return NextResponse.json({ ok: false, error: failure.message }, { status: failure.status, headers: { 'cache-control': 'no-store' } });
  }
}
