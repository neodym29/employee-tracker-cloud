import type { Metadata } from 'next';
import { requireApprovedSession } from '@/lib/auth';
import ChatsClient from './ChatsClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Chats | Neo Nexus' };

export default async function ChatsPage() {
  const session = await requireApprovedSession();
  return <ChatsClient userId={session.id} />;
}
