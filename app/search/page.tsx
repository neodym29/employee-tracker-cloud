import type { Metadata } from 'next';
import { requireApprovedSession } from '@/lib/auth';
import SearchClient from './SearchClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Search | Neo Nexus' };

export default async function SearchPage() {
  await requireApprovedSession();
  return <SearchClient />;
}
