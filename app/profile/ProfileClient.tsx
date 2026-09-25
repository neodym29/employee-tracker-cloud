'use client';

import { useEffect, useRef, useState } from 'react';
import ProfileAvatar, { type AvatarProfile } from '@/app/components/ProfileAvatar';
import { PROFILE_PRESETS, profilePreset } from '@/lib/profile-presets';

type Profile = AvatarProfile & {
  name: string;
  email: string;
  accountType: string;
  bio: string;
  statusText: string;
  avatarKind: 'initials' | 'preset' | 'photo';
  hasPhoto: boolean;
};

function PortraitChoice({ label, image, chosen, onClick }: { label: string; image: string; chosen: boolean; onClick: () => void }) {
  return <button type="button" className={`socialAvatarChoice socialAvatarPortraitChoice ${chosen ? 'chosen' : ''}`} aria-label={label} aria-pressed={chosen} onClick={onClick}>
    <img className="socialAvatarPortraitImage" src={image} alt="" />
    <span className="socialAvatarPortraitName" aria-hidden="true">{label}</span>
  </button>;
}

export default function ProfileClient({ userId }: { userId: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [statusText, setStatusText] = useState('');
  const [avatarKind, setAvatarKind] = useState<Profile['avatarKind']>('initials');
  const [avatarPreset, setAvatarPreset] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  function acceptProfile(next: Profile) {
    setProfile(next); setName(next.name); setBio(next.bio); setStatusText(next.statusText);
    const availablePreset = profilePreset(next.avatarPreset);
    setAvatarKind(next.avatarKind === 'preset' && !availablePreset ? 'initials' : next.avatarKind);
    setAvatarPreset(availablePreset?.id || null);
    window.dispatchEvent(new Event('profile:updated'));
  }

  useEffect(() => {
    void fetch('/api/profile', { cache: 'no-store' }).then(response => response.json()).then(data => {
      if (!data.ok) throw new Error(data.error || 'Profile unavailable');
      acceptProfile(data.profile);
    }).catch(cause => setError((cause as Error).message));
  }, []);

  async function save() {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/profile', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, bio, statusText, avatarKind, avatarPreset }) });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Could not save your profile');
      acceptProfile(data.profile);
      setMessage('Profile saved. Your changes now appear in chats.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function uploadPhoto(file: File | undefined) {
    if (!file || busy) return;
    if (file.size > 2 * 1024 * 1024) { setError('Choose a photo under 2 MB.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const form = new FormData(); form.set('photo', file);
      const response = await fetch('/api/profile/photo', { method: 'POST', body: form });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Could not upload your photo');
      if (profile) {
        setProfile(data.profile); setAvatarKind('photo'); setAvatarPreset(null);
        window.dispatchEvent(new Event('profile:updated'));
      } else acceptProfile(data.profile);
      setMessage('Photo uploaded and added to your profile.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  }

  async function removePhoto() {
    if (busy || !window.confirm('Remove your uploaded profile photo? This cannot be undone.')) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/profile/photo', { method: 'DELETE' });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Could not remove your photo');
      setProfile(data.profile);
      if (avatarKind === 'photo') setAvatarKind('initials');
      window.dispatchEvent(new Event('profile:updated'));
      setMessage('Photo removed from your profile.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  const preview: AvatarProfile = { id: userId, name: name || profile?.name || 'You', avatarKind, avatarPreset, avatarUpdatedAt: profile?.avatarUpdatedAt };

  return <div className="socialProfilePage">
    <div className="socialProfileBanner" aria-hidden="true"><span>✦</span><span>✶</span><span>✦</span></div>
    <div className="socialProfileShell">
      <section className="socialProfileHero" aria-label="Your profile preview">
        <ProfileAvatar profile={preview} size="xl" alt={`${name || 'Your'} profile picture`} />
        <div className="socialProfileIdentity"><span className="socialProfileEyebrow">YOUR NEO-NEXUS PROFILE</span><h1>{name || 'Your profile'}</h1><p>{profile?.email || ''}</p><div className="socialProfilePills"><span>{profile?.accountType || 'Member'}</span>{statusText && <span className="socialProfileStatus"><i aria-hidden="true" />{statusText}</span>}</div></div>
        <a className="socialProfileBack" href="/chats">Back to chats</a>
      </section>
      {bio && <p className="socialProfileBioPreview">{bio}</p>}
      <div className="socialProfileEditor">
        <section className="socialProfileCard"><div className="socialProfileCardHeading"><h2>About you</h2><p>Give teammates a little context when they see you in chat.</p></div>
          <label>Display name<input value={name} onChange={event => setName(event.target.value)} maxLength={60} placeholder="Your name" /></label>
          <label>Status<input value={statusText} onChange={event => setStatusText(event.target.value)} maxLength={80} placeholder="What are you working on?" /></label>
          <label>Bio<textarea value={bio} onChange={event => setBio(event.target.value)} maxLength={280} rows={4} placeholder="A few words about you..." /><small>{bio.length}/280</small></label>
        </section>
        <section className="socialProfileCard"><div className="socialProfileCardHeading"><h2>Profile picture</h2><p>Pick an avatar or upload a photo. Your choice appears throughout chats.</p></div>
          <div className="socialAvatarChoices socialAvatarUtilityChoices"><button type="button" className={`socialAvatarChoice ${avatarKind === 'initials' ? 'chosen' : ''}`} aria-pressed={avatarKind === 'initials'} onClick={() => { setAvatarKind('initials'); setAvatarPreset(null); }}><ProfileAvatar profile={{ id: userId, name: name || 'You' }} size="lg" /><span>Initials</span></button>
            {profile?.hasPhoto && <PortraitChoice label="Your photo" image={`/api/profiles/${encodeURIComponent(userId)}/photo?v=${encodeURIComponent(profile.avatarUpdatedAt || '')}`} chosen={avatarKind === 'photo'} onClick={() => { setAvatarKind('photo'); setAvatarPreset(null); }} />}
          </div>
          {(['Games', 'Anime', 'Kakegurui'] as const).map(category => <div className="socialAvatarGroup" key={category}><h3>{category === 'Games' ? 'Game characters' : category === 'Anime' ? 'Anime characters' : 'Kakegurui characters'}</h3><div className="socialAvatarChoices">{PROFILE_PRESETS.filter(preset => preset.category === category).map(preset => <PortraitChoice key={preset.id} label={preset.label} image={preset.image} chosen={avatarKind === 'preset' && avatarPreset === preset.id} onClick={() => { setAvatarKind('preset'); setAvatarPreset(preset.id); }} />)}</div></div>)}
          <input ref={fileRef} className="srOnly" type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose a profile photo" onChange={event => void uploadPhoto(event.target.files?.[0])} />
          <div className="socialPhotoActions"><button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Please wait…' : 'Upload photo'}</button>{profile?.hasPhoto && <button type="button" className="socialRemovePhoto" disabled={busy} onClick={() => void removePhoto()}>Remove uploaded photo</button>}</div>
          <small className="socialPhotoNote">PNG, JPEG, or WebP · 2 MB maximum · automatically cropped to a square</small>
        </section>
      </div>
      <div className="socialProfileFooter"><p>Visible to approved Neo-Nexus members.</p><button type="button" disabled={busy || !profile} onClick={() => void save()}>{busy ? 'Saving…' : 'Save profile'}</button></div>
      {message && <p className="socialProfileNotice" role="status">{message}</p>}{error && <p className="socialProfileError" role="alert">{error}</p>}
    </div>
  </div>;
}
