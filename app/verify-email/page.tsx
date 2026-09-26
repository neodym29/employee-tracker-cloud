import type { Metadata } from 'next';
import { requireApprovedSession } from '@/lib/auth';
import VerifyEmailClient from './VerifyEmailClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Verify email | Neo-Nexus' };

export default async function VerifyEmailPage() {
  await requireApprovedSession();
  return <VerifyEmailClient />;
}
