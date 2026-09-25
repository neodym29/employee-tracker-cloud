import { NextRequest } from 'next/server';
import { probeChatBackend } from '@/lib/chat-backend-probe';
export const runtime = 'nodejs';
export const maxDuration = 300;
export async function POST(req: NextRequest) {
  return probeChatBackend(req.headers.get('x-admin-setup-key') || '');
}
