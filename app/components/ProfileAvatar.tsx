import { profilePreset } from '@/lib/profile-presets';

export type AvatarProfile = {
  id: string;
  name?: string;
  avatarKind?: 'initials' | 'preset' | 'photo' | null;
  avatarPreset?: string | null;
  avatarUpdatedAt?: string | null;
};

export default function ProfileAvatar({ profile, size = 'md', className = '', alt = '' }: {
  profile: AvatarProfile;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  alt?: string;
}) {
  const preset = profile.avatarKind === 'preset' ? profilePreset(profile.avatarPreset) : null;
  const initials = (profile.name || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() || '').join('') || '?';
  return <span className={`profileAvatar profileAvatar-${size} ${className}`} aria-hidden={alt ? undefined : true} role={alt ? 'img' : undefined} aria-label={alt || undefined}>
    {profile.avatarKind === 'photo' ? <img src={`/api/profiles/${encodeURIComponent(profile.id)}/photo?v=${encodeURIComponent(profile.avatarUpdatedAt || '')}`} alt="" /> : preset ? <img src={preset.image} alt="" /> : <span className="profileAvatarInitials">{initials}</span>}
  </span>;
}
