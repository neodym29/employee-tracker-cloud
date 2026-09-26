import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireApprovedSession } from '@/lib/auth';
import { getVisibleProfile } from '@/lib/profiles';
import ProfileAvatar from '@/app/components/ProfileAvatar';

type Props = { params: Promise<{ userId: string }> };
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Teammate profile | Neo Nexus' };

export default async function TeammateProfilePage({ params }: Props) {
  const session = await requireApprovedSession();
  const { userId } = await params;
  if (userId === session.id) redirect('/profile');
  const profile = await getVisibleProfile(session, userId);
  return <div className="socialProfilePage socialProfilePublic">
    <div className="socialProfileBanner" aria-hidden="true"><span>✦</span><span>✶</span><span>✦</span></div>
    <div className="socialProfileShell"><section className="socialProfileHero"><ProfileAvatar profile={profile} size="xl" alt={`${profile.name}'s profile picture`} /><div className="socialProfileIdentity"><span className="socialProfileEyebrow">NEO-NEXUS TEAMMATE</span><h1>{profile.name}{profile.emailVerified && <span className="verifiedBadge" title="Email verified" aria-label="Email verified">✓</span>}</h1><div className="socialProfilePills"><span>{profile.accountType}</span>{profile.statusText && <span className="socialProfileStatus"><i aria-hidden="true" />{profile.statusText}</span>}</div></div></section>
      <section className="socialPublicAbout"><h2>About</h2><p>{profile.bio || 'No bio yet.'}</p></section>
    </div>
  </div>;
}
