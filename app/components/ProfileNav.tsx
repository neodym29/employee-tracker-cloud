'use client';

import { useEffect, useState } from 'react';
import ProfileAvatar, { type AvatarProfile } from './ProfileAvatar';

export default function ProfileNav({ userId, fallbackName }: { userId: string; fallbackName: string }) {
  const [profile, setProfile] = useState<AvatarProfile>({ id: userId, name: fallbackName });
  useEffect(() => {
    let mounted = true;
    const load = () => {
      void fetch('/api/profile', { cache: 'no-store' }).then(response => response.json()).then(data => {
        if (mounted && data.ok) setProfile(data.profile);
      }).catch(() => {});
    };
    load();
    window.addEventListener('profile:updated', load);
    return () => { mounted = false; window.removeEventListener('profile:updated', load); };
  }, []);
  return <a className="profileNavLink" href="/profile" aria-label="Your profile" title="Your profile"><ProfileAvatar profile={profile} size="sm" /><span>Profile</span></a>;
}
