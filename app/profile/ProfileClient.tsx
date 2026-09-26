'use client';

import { useEffect, useRef, useState } from 'react';
import ProfileAvatar, { type AvatarProfile } from '@/app/components/ProfileAvatar';
import { PROFILE_PRESETS, profilePreset } from '@/lib/profile-presets';
import { APPEARANCE_FONTS, APPEARANCE_SIZES, APPEARANCE_THEMES, DEFAULT_APPEARANCE, isAppearanceFont, isAppearanceSize, isAppearanceTheme, type Appearance, type AppearanceFont, type AppearanceSize, type AppearanceTheme } from '@/lib/appearance';
import { alertsEnabled, disableAlerts, enableAlerts } from '@/lib/message-alerts';

type Profile = AvatarProfile & {
  name: string;
  email: string;
  accountType: string;
  bio: string;
  statusText: string;
  avatarKind: 'initials' | 'preset' | 'photo';
  hasPhoto: boolean;
  appearanceTheme: AppearanceTheme;
  appearanceFont: AppearanceFont;
  appearanceSize: AppearanceSize;
  emailVerified: boolean;
};
type ProfileDraft = Pick<Profile, 'name' | 'bio' | 'statusText' | 'avatarKind' | 'avatarPreset'>;

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
  const [pictureOpen, setPictureOpen] = useState(false);
  const [pictureCategory, setPictureCategory] = useState<(typeof PROFILE_PRESETS)[number]['category']>('Games');
  const [appearanceTheme, setAppearanceTheme] = useState<AppearanceTheme>(DEFAULT_APPEARANCE.theme);
  const [appearanceFont, setAppearanceFont] = useState<AppearanceFont>(DEFAULT_APPEARANCE.font);
  const [appearanceSize, setAppearanceSize] = useState<AppearanceSize>(DEFAULT_APPEARANCE.size);
  const [editingName, setEditingName] = useState(false);
  const [appearanceBusy, setAppearanceBusy] = useState(false);
  const [messageAlerts, setMessageAlerts] = useState(false);
  const [alertStatus, setAlertStatus] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [securityBusy, setSecurityBusy] = useState(false);
  const [securityMessage, setSecurityMessage] = useState('');
  const [securityError, setSecurityError] = useState('');
  const appearanceRef = useRef<Appearance>(DEFAULT_APPEARANCE);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const scrollPictureOnOpen = useRef(false);
  const draftRef = useRef<ProfileDraft>({ name: '', bio: '', statusText: '', avatarKind: 'initials', avatarPreset: null });
  const savedRef = useRef('');
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function acceptProfile(next: Profile) {
    setProfile(next); setName(next.name); setBio(next.bio); setStatusText(next.statusText);
    const availablePreset = profilePreset(next.avatarPreset);
    const avatarKind = next.avatarKind === 'preset' && !availablePreset ? 'initials' : next.avatarKind;
    const avatarPreset = availablePreset?.id || null;
    setAvatarKind(avatarKind);
    setAvatarPreset(avatarPreset);
    draftRef.current = { name: next.name, bio: next.bio, statusText: next.statusText, avatarKind, avatarPreset };
    savedRef.current = JSON.stringify(draftRef.current);
    const appearance: Appearance = {
      theme: isAppearanceTheme(next.appearanceTheme) ? next.appearanceTheme : DEFAULT_APPEARANCE.theme,
      font: isAppearanceFont(next.appearanceFont) ? next.appearanceFont : DEFAULT_APPEARANCE.font,
      size: isAppearanceSize(next.appearanceSize) ? next.appearanceSize : DEFAULT_APPEARANCE.size,
    };
    appearanceRef.current = appearance;
    setAppearanceTheme(appearance.theme); setAppearanceFont(appearance.font); setAppearanceSize(appearance.size);
    document.documentElement.dataset.theme = appearance.theme;
    document.documentElement.dataset.font = appearance.font;
    document.documentElement.dataset.fontSize = appearance.size;
    window.dispatchEvent(new Event('profile:updated'));
  }

  async function changeAppearance(next: Appearance) {
    if (!profile || appearanceBusy) return;
    const previous = appearanceRef.current;
    appearanceRef.current = next;
    setAppearanceTheme(next.theme); setAppearanceFont(next.font); setAppearanceSize(next.size);
    document.documentElement.dataset.theme = next.theme;
    document.documentElement.dataset.font = next.font;
    document.documentElement.dataset.fontSize = next.size;
    setAppearanceBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/profile/appearance', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Could not save appearance');
      setProfile(current => current ? { ...current, appearanceTheme: next.theme, appearanceFont: next.font, appearanceSize: next.size } : current);
      window.dispatchEvent(new Event('appearance:updated'));
      setMessage('Appearance saved for your account.');
    } catch (cause) {
      appearanceRef.current = previous;
      setAppearanceTheme(previous.theme); setAppearanceFont(previous.font); setAppearanceSize(previous.size);
      document.documentElement.dataset.theme = previous.theme;
      document.documentElement.dataset.font = previous.font;
      document.documentElement.dataset.fontSize = previous.size;
      setError((cause as Error).message);
    } finally { setAppearanceBusy(false); }
  }

  useEffect(() => {
    setMessageAlerts(alertsEnabled() && 'Notification' in window && Notification.permission === 'granted');
    void fetch('/api/profile', { cache: 'no-store' }).then(response => response.json()).then(data => {
      if (!data.ok) throw new Error(data.error || 'Profile unavailable');
      acceptProfile(data.profile);
    }).catch(cause => setError((cause as Error).message));
  }, []);

  useEffect(() => {
    const syncAppearance = () => {
      const current = document.documentElement.dataset;
      if (isAppearanceTheme(current.theme) && isAppearanceFont(current.font) && isAppearanceSize(current.fontSize)) {
        const next = { theme: current.theme, font: current.font, size: current.fontSize };
        appearanceRef.current = next;
        setAppearanceTheme(next.theme); setAppearanceFont(next.font); setAppearanceSize(next.size);
        setProfile(profile => profile ? { ...profile, appearanceTheme: next.theme, appearanceFont: next.font, appearanceSize: next.size } : profile);
      }
    };
    window.addEventListener('appearance:updated', syncAppearance);
    return () => window.removeEventListener('appearance:updated', syncAppearance);
  }, []);

  useEffect(() => { if (editingName) nameInputRef.current?.focus(); }, [editingName]);
  useEffect(() => {
    if (pictureOpen && scrollPictureOnOpen.current) {
      document.getElementById('profile-picture-options')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      scrollPictureOnOpen.current = false;
    }
  }, [pictureOpen]);

  async function toggleMessageAlerts() {
    if (messageAlerts) {
      disableAlerts(); setMessageAlerts(false); setAlertStatus('Message alerts off.');
      return;
    }
    const result = await enableAlerts();
    if (result === 'enabled') { setMessageAlerts(true); setAlertStatus('Message alerts on.'); }
    else setAlertStatus(result === 'unsupported' ? 'This browser does not support notifications.' : 'Allow notifications in your browser to turn on alerts.');
  }

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSecurityError(''); setSecurityMessage('');
    if (newPassword !== confirmPassword) { setSecurityError('New passwords do not match.'); return; }
    setSecurityBusy(true);
    try {
      const response = await fetch('/api/profile/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword, newPassword }) });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Could not change password');
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      setSecurityMessage('Password changed. Other sessions have been signed out.');
    } catch (cause) { setSecurityError((cause as Error).message); }
    finally { setSecurityBusy(false); }
  }

  async function sendVerificationEmail() {
    setSecurityBusy(true); setSecurityError(''); setSecurityMessage('');
    try {
      const response = await fetch('/api/profile/verify-email', { method: 'POST' });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Could not send verification email');
      if (data.alreadyVerified) setProfile(current => current ? { ...current, emailVerified: true } : current);
      setSecurityMessage(data.alreadyVerified ? 'Email already verified.' : 'Verification link sent. Check your inbox.');
    } catch (cause) { setSecurityError((cause as Error).message); }
    finally { setSecurityBusy(false); }
  }

  function persistDraft(): Promise<boolean> {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const next = { ...draftRef.current };
    const serialized = JSON.stringify(next);
    if (!profile) return saveQueue.current;
    const run = async () => {
      if (serialized === savedRef.current) return true;
      setSaving(true); setError(''); setMessage('');
      try {
        const response = await fetch('/api/profile', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: serialized, keepalive: true });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error || 'Could not save your profile');
        savedRef.current = serialized;
        setSaveError(false);
        setProfile(data.profile);
        window.dispatchEvent(new Event('profile:updated'));
        setMessage('Saved');
        return true;
      } catch (cause) {
        setSaveError(true);
        setError((cause as Error).message);
        return false;
      } finally { setSaving(false); }
    };
    saveQueue.current = saveQueue.current.then(run, run);
    return saveQueue.current;
  }

  function updateDraft(patch: Partial<ProfileDraft>, immediate = false) {
    draftRef.current = { ...draftRef.current, ...patch };
    setError(''); setSaveError(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void persistDraft(); }, immediate ? 0 : 650);
  }

  function chooseAvatar(kind: Profile['avatarKind'], preset: string | null = null) {
    setAvatarKind(kind); setAvatarPreset(preset); setPictureOpen(false);
    updateDraft({ avatarKind: kind, avatarPreset: preset }, true);
  }

  function openPictureChoices(fromHero = false) {
    scrollPictureOnOpen.current = fromHero && !pictureOpen;
    setPictureOpen(open => !open);
  }

  function cancelNameEdit() {
    if (profile) {
      setName(profile.name);
      updateDraft({ name: profile.name }, true);
    }
    setEditingName(false);
  }

  async function uploadPhoto(file: File | undefined) {
    if (!file || busy) return;
    if (file.size > 2 * 1024 * 1024) { setError('Choose a photo under 2 MB.'); return; }
    if (!(await persistDraft())) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const form = new FormData(); form.set('photo', file);
      const response = await fetch('/api/profile/photo', { method: 'POST', body: form });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Could not upload your photo');
      if (profile) {
        setProfile(data.profile); setAvatarKind('photo'); setAvatarPreset(null);
        draftRef.current = { ...draftRef.current, avatarKind: 'photo', avatarPreset: null };
        savedRef.current = JSON.stringify(draftRef.current);
        window.dispatchEvent(new Event('profile:updated'));
      } else acceptProfile(data.profile);
      setMessage('Photo uploaded and added to your profile.');
      setPictureOpen(false);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  }

  async function removePhoto() {
    if (busy || !window.confirm('Remove your uploaded profile photo? This cannot be undone.')) return;
    if (!(await persistDraft())) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/profile/photo', { method: 'DELETE' });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Could not remove your photo');
      setProfile(data.profile);
      setAvatarKind(data.profile.avatarKind); setAvatarPreset(data.profile.avatarPreset);
      draftRef.current = { ...draftRef.current, avatarKind: data.profile.avatarKind, avatarPreset: data.profile.avatarPreset };
      savedRef.current = JSON.stringify(draftRef.current);
      window.dispatchEvent(new Event('profile:updated'));
      setMessage('Photo removed from your profile.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  const preview: AvatarProfile = { id: userId, name: name || profile?.name || 'You', avatarKind, avatarPreset, avatarUpdatedAt: profile?.avatarUpdatedAt };
  const pictureLabel = avatarKind === 'photo' ? 'Your uploaded photo' : avatarKind === 'preset' ? profilePreset(avatarPreset)?.label || 'Character avatar' : 'Your initials';

  return <div className="socialProfilePage">
    <div className="socialProfileBanner" aria-hidden="true"><span>✦</span><span>✶</span><span>✦</span></div>
    <div className="socialProfileShell">
      <section className="socialProfileHero" aria-label="Your profile preview">
        <button type="button" className="socialProfileAvatarEdit" aria-label="Change profile picture" aria-expanded={pictureOpen} disabled={!profile} onClick={() => openPictureChoices(true)}><ProfileAvatar profile={preview} size="xl" alt="" /><span aria-hidden="true">✎</span></button>
        <div className="socialProfileIdentity"><h1>{editingName ? <input ref={nameInputRef} aria-label="Display name" value={name} maxLength={60} onChange={event => { setName(event.target.value); updateDraft({ name: event.target.value }); }} onBlur={() => { setEditingName(false); void persistDraft(); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') cancelNameEdit(); }} /> : <button type="button" className="socialProfileNameEdit" aria-label="Edit display name" disabled={!profile} onClick={() => setEditingName(true)}>{name || 'Your profile'}<span aria-hidden="true">✎</span></button>}{profile?.emailVerified && <span className="verifiedBadge" title="Email verified" aria-label="Email verified">✓</span>}</h1><p>{profile?.email || ''}</p><div className="socialProfilePills"><span>{profile?.accountType || 'Member'}</span>{statusText && <span className="socialProfileStatus"><i aria-hidden="true" />{statusText}</span>}</div></div>
      </section>
      {bio && <p className="socialProfileBioPreview">{bio}</p>}
      <div className="socialProfileEditor">
        <section className="socialProfileCard"><div className="socialProfileCardHeading socialProfileAutosaveHeading"><h2>About you</h2><span role="status">{saving ? 'Saving…' : message === 'Saved' ? 'Saved' : ''}</span></div>
          <label>Status<input value={statusText} disabled={!profile} onChange={event => { setStatusText(event.target.value); updateDraft({ statusText: event.target.value }); }} onBlur={() => void persistDraft()} maxLength={80} placeholder="What are you working on?" /></label>
          <label>Bio<textarea value={bio} disabled={!profile} onChange={event => { setBio(event.target.value); updateDraft({ bio: event.target.value }); }} onBlur={() => void persistDraft()} maxLength={280} rows={4} placeholder="A few words about you..." /><small>{bio.length}/280</small></label>
        </section>
        <div className="socialProfileSide">
          <section className="socialProfileCard"><div className="socialProfileCardHeading"><h2>Profile picture</h2></div>
            <button type="button" className="socialPicturePreview" aria-label="Change profile picture" aria-expanded={pictureOpen} aria-controls="profile-picture-options" disabled={!profile} onClick={() => openPictureChoices()}><ProfileAvatar profile={preview} size="lg" /><strong>{pictureLabel}</strong><span aria-hidden="true">✎</span></button>
            {pictureOpen && <div id="profile-picture-options" className="socialPictureOptions">
              <div className="socialPictureCategory" aria-label="Avatar category">{(['Games', 'Anime', 'Cartoons'] as const).map(category => <button key={category} type="button" aria-pressed={pictureCategory === category} onClick={() => setPictureCategory(category)}>{category}</button>)}</div>
              <div className="socialAvatarChoices">{PROFILE_PRESETS.filter(preset => preset.category === pictureCategory).map(preset => <PortraitChoice key={preset.id} label={preset.label} image={preset.image} chosen={avatarKind === 'preset' && avatarPreset === preset.id} onClick={() => chooseAvatar('preset', preset.id)} />)}</div>
              <div className="socialPhotoActions"><button type="button" className="socialPictureSecondary" onClick={() => chooseAvatar('initials')}>Use initials</button>{profile?.hasPhoto && <button type="button" className="socialPictureSecondary" onClick={() => chooseAvatar('photo')}>Use uploaded photo</button>}<button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Please wait…' : 'Upload photo'}</button>{profile?.hasPhoto && <button type="button" className="socialRemovePhoto" disabled={busy} onClick={() => void removePhoto()}>Remove uploaded photo</button>}</div>
              <input ref={fileRef} className="srOnly" type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose a profile photo" onChange={event => void uploadPhoto(event.target.files?.[0])} />
              <small className="socialPhotoNote">PNG, JPEG, or WebP · 2 MB maximum</small>
            </div>}
          </section>
          <section id="appearance" className="socialProfileCard"><div className="socialProfileCardHeading"><h2>Appearance</h2></div>
            <div className="socialAppearanceSection"><h3>Color theme</h3><div className="socialThemeChoices">{APPEARANCE_THEMES.map(option => <button key={option.id} type="button" disabled={!profile || appearanceBusy} aria-pressed={appearanceTheme === option.id} onClick={() => void changeAppearance({ theme: option.id, font: appearanceFont, size: appearanceSize })}><i style={{ backgroundColor: option.swatch }} aria-hidden="true" /><span>{option.label}</span></button>)}</div></div>
            <div className="socialAppearanceSection"><h3>Font</h3><div className="socialFontChoices">{APPEARANCE_FONTS.map(option => <button key={option.id} type="button" disabled={!profile || appearanceBusy} aria-pressed={appearanceFont === option.id} onClick={() => void changeAppearance({ theme: appearanceTheme, font: option.id, size: appearanceSize })}><strong>{option.label}</strong><span>{option.sample}</span></button>)}</div></div>
            <div className="socialAppearanceSection"><h3>Font size</h3><div className="socialFontSizeChoices">{APPEARANCE_SIZES.map(option => <button key={option.id} type="button" disabled={!profile || appearanceBusy} aria-pressed={appearanceSize === option.id} onClick={() => void changeAppearance({ theme: appearanceTheme, font: appearanceFont, size: option.id })}>{option.label}</button>)}</div></div>
          </section>
          <section className="socialProfileCard"><div className="socialProfileCardHeading"><h2>Message alerts</h2></div>
            <button type="button" className="socialAlertToggle" aria-pressed={messageAlerts} onClick={() => void toggleMessageAlerts()}>{messageAlerts ? 'Browser alerts on' : 'Turn on browser alerts'}</button>
            {alertStatus && <p className="socialAlertStatus" role="status">{alertStatus}</p>}
          </section>
          <section id="security" className="socialProfileCard socialSecurityCard"><div className="socialProfileCardHeading"><h2>Account security</h2></div>
            <div className="socialSecurityEmail"><strong>Email verification</strong><span>{profile?.emailVerified ? <><span className="verifiedBadge" aria-hidden="true">✓</span> Verified</> : 'Not verified'}</span></div>
            {!profile?.emailVerified && <button type="button" disabled={!profile || securityBusy} onClick={() => void sendVerificationEmail()}>Send verification email</button>}
            <form onSubmit={event => void changePassword(event)}><h3>Change password</h3>
              <label>Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></label>
              <label>New password<input type="password" autoComplete="new-password" required minLength={8} maxLength={1024} value={newPassword} onChange={event => setNewPassword(event.target.value)} /></label>
              <label>Confirm new password<input type="password" autoComplete="new-password" required value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} /></label>
              <button type="submit" disabled={securityBusy || !profile}>Change password</button>
            </form>
            {securityMessage && <p role="status" className="socialSecuritySuccess">{securityMessage}</p>}
            {securityError && <p role="alert" className="socialProfileError">{securityError}</p>}
          </section>
        </div>
      </div>
      {message && message !== 'Saved' && <p className="socialProfileNotice" role="status">{message}</p>}{error && <p className="socialProfileError" role="alert">{error}{saveError && <> <button type="button" className="socialProfileRetry" onClick={() => void persistDraft()}>Retry</button></>}</p>}
    </div>
  </div>;
}
