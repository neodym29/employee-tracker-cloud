import type { Metadata } from 'next';
import { requireApprovedSession } from '@/lib/auth';
import ProfileClient from './ProfileClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Your profile | Neo-Nexus' };

export default async function ProfilePage() {
  const session = await requireApprovedSession();
  return <ProfileClient userId={session.id} />;
}
