import sharp from 'sharp';
import type { SessionUser } from './auth';
import { ApiError } from './api';
import { getPool } from './db';
import { profilePreset } from './profile-presets';
import { DEFAULT_APPEARANCE, isAppearanceFont, isAppearanceSize, isAppearanceTheme, type Appearance } from './appearance';

let schemaReady: Promise<void> | null = null;

export async function ensureProfilesSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = getPool().query(`
    create table if not exists user_social_profiles (
      user_id bigint primary key references app_users(id) on delete cascade,
      bio text not null default '' check (length(bio) <= 280),
      status_text text not null default '' check (length(status_text) <= 80),
      avatar_kind text not null default 'initials' check (avatar_kind in ('initials', 'preset', 'photo')),
      avatar_preset text,
      photo_bytes bytea,
      photo_mime text,
      avatar_updated_at timestamptz not null default now(),
      appearance_theme text not null default 'classic',
      appearance_font text not null default 'system',
      appearance_size text not null default 'normal',
      updated_at timestamptz not null default now()
    );
    alter table user_social_profiles
      add column if not exists appearance_theme text not null default 'classic',
      add column if not exists appearance_font text not null default 'system',
      add column if not exists appearance_size text not null default 'normal';
    alter table app_users add column if not exists email_verified_at timestamptz;
    alter table app_users add column if not exists password_changed_at timestamptz;
    alter table app_users add column if not exists session_version integer not null default 0;
    create table if not exists email_verification_tokens (
      user_id bigint primary key references app_users(id) on delete cascade,
      email text not null,
      token_hash text not null unique,
      expires_at timestamptz not null,
      sent_at timestamptz not null default now()
    );
  `).then(() => undefined).catch((error) => { schemaReady = null; throw error; });
  return schemaReady;
}

const profileColumns = `u.id::text as id,
  coalesce(nullif(u.display_name,''),split_part(u.email,'@',1)) as name,
  u.account_type as "accountType", u.email,
  coalesce(p.bio,'') as bio, coalesce(p.status_text,'') as "statusText",
  coalesce(p.avatar_kind,'initials') as "avatarKind", p.avatar_preset as "avatarPreset",
  p.avatar_updated_at as "avatarUpdatedAt", p.photo_bytes is not null as "hasPhoto",
  coalesce(p.appearance_theme,'classic') as "appearanceTheme",
  coalesce(p.appearance_font,'system') as "appearanceFont",
  coalesce(p.appearance_size,'normal') as "appearanceSize",
  u.email_verified_at is not null as "emailVerified"`;

export async function getOwnAppearance(userId: string): Promise<Appearance> {
  await ensureProfilesSchema();
  const result = await getPool().query(`select appearance_theme,appearance_font,appearance_size from user_social_profiles where user_id=$1`, [userId]);
  const row = result.rows[0];
  return {
    theme: isAppearanceTheme(row?.appearance_theme) ? row.appearance_theme : DEFAULT_APPEARANCE.theme,
    font: isAppearanceFont(row?.appearance_font) ? row.appearance_font : DEFAULT_APPEARANCE.font,
    size: isAppearanceSize(row?.appearance_size) ? row.appearance_size : DEFAULT_APPEARANCE.size,
  };
}

export async function setOwnAppearance(session: SessionUser, input: Record<string, unknown>): Promise<Appearance> {
  if (!isAppearanceTheme(input.theme) || !isAppearanceFont(input.font) || !isAppearanceSize(input.size)) {
    throw new ApiError('Choose a valid color theme, font, and size', 400, 'invalid_appearance');
  }
  await ensureProfilesSchema();
  await getPool().query(`insert into user_social_profiles(user_id,appearance_theme,appearance_font,appearance_size)
    values($1,$2,$3,$4)
    on conflict(user_id) do update set appearance_theme=excluded.appearance_theme,
    appearance_font=excluded.appearance_font,appearance_size=excluded.appearance_size,updated_at=now()`, [session.id, input.theme, input.font, input.size]);
  return { theme: input.theme, font: input.font, size: input.size };
}

export async function getVisibleProfile(session: SessionUser, userId: string) {
  await ensureProfilesSchema();
  if (!/^[1-9]\d{0,18}$/.test(userId)) throw new ApiError('Invalid profile', 400, 'invalid_id');
  const result = await getPool().query(`select ${profileColumns}
    from app_users u left join user_social_profiles p on p.user_id=u.id
    where u.id=$1 and u.company_id=$2 and u.approval_status='approved'`, [userId, session.company_id]);
  if (!result.rows[0]) throw new ApiError('Profile not found', 404, 'not_found');
  return result.rows[0];
}

function cleanText(value: unknown, label: string, max: number, min = 0, multiline = false) {
  if (typeof value !== 'string') throw new ApiError(`Invalid ${label.toLowerCase()}`, 400, 'invalid_profile');
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text.length < min || text.length > max || (multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(text)) {
    throw new ApiError(`${label} must be ${min}–${max} characters`, 400, 'invalid_profile');
  }
  return text;
}

export async function updateOwnProfile(session: SessionUser, input: Record<string, unknown>) {
  await ensureProfilesSchema();
  const name = cleanText(input.name, 'Name', 60, 2);
  const bio = cleanText(input.bio, 'Bio', 280, 0, true);
  const statusText = cleanText(input.statusText, 'Status', 80);
  const avatarKind = input.avatarKind;
  if (avatarKind !== 'initials' && avatarKind !== 'preset' && avatarKind !== 'photo') throw new ApiError('Choose an avatar', 400, 'invalid_avatar');
  const avatarPreset = avatarKind === 'preset' && typeof input.avatarPreset === 'string' ? profilePreset(input.avatarPreset)?.id : null;
  if (avatarKind === 'preset' && !avatarPreset) throw new ApiError('Choose a valid avatar', 400, 'invalid_avatar');
  const db = await getPool().connect();
  try {
    await db.query('begin');
    if (avatarKind === 'photo') {
      const hasPhoto = await db.query(`select photo_bytes is not null as has_photo from user_social_profiles where user_id=$1`, [session.id]);
      if (!hasPhoto.rows[0]?.has_photo) throw new ApiError('Upload a photo first', 400, 'photo_missing');
    }
    await db.query(`update app_users set display_name=$2 where id=$1 and company_id=$3`, [session.id, name, session.company_id]);
    await db.query(`insert into user_social_profiles(user_id,bio,status_text,avatar_kind,avatar_preset)
      values($1,$2,$3,$4,$5)
      on conflict(user_id) do update set bio=excluded.bio,status_text=excluded.status_text,
      avatar_kind=excluded.avatar_kind,avatar_preset=excluded.avatar_preset,updated_at=now()`,
      [session.id, bio, statusText, avatarKind, avatarPreset]);
    await db.query('commit');
  } catch (error) { await db.query('rollback'); throw error; }
  finally { db.release(); }
  return getVisibleProfile(session, session.id);
}

function validImageSignature(bytes: Buffer) {
  return (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    || (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
}

export async function saveOwnPhoto(session: SessionUser, raw: Buffer, mime: string) {
  await ensureProfilesSchema();
  if (raw.length < 16 || raw.length > 2 * 1024 * 1024 || !['image/jpeg','image/png','image/webp'].includes(mime) || !validImageSignature(raw)) {
    throw new ApiError('Choose a PNG, JPEG, or WebP image under 2 MB', 400, 'invalid_photo');
  }
  let photo: Buffer;
  try {
    photo = await sharp(raw, { limitInputPixels: 20_000_000, failOn: 'error' })
      .rotate().resize(256, 256, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
  } catch { throw new ApiError('This image could not be read', 400, 'invalid_photo'); }
  if (photo.length > 256 * 1024) throw new ApiError('This image is too complex; choose another', 400, 'invalid_photo');
  await getPool().query(`insert into user_social_profiles(user_id,avatar_kind,avatar_preset,photo_bytes,photo_mime,avatar_updated_at)
    values($1,'photo',null,$2,'image/webp',now())
    on conflict(user_id) do update set avatar_kind='photo',avatar_preset=null,photo_bytes=excluded.photo_bytes,
      photo_mime='image/webp',avatar_updated_at=now(),updated_at=now()`, [session.id, photo]);
  return getVisibleProfile(session, session.id);
}

export async function removeOwnPhoto(session: SessionUser) {
  await ensureProfilesSchema();
  await getPool().query(`update user_social_profiles set photo_bytes=null,photo_mime=null,
    avatar_kind=case when avatar_kind='photo' then 'initials' else avatar_kind end,
    avatar_updated_at=now(),updated_at=now() where user_id=$1`, [session.id]);
  return getVisibleProfile(session, session.id);
}

export async function getVisiblePhoto(session: SessionUser, userId: string): Promise<Buffer> {
  await ensureProfilesSchema();
  if (!/^[1-9]\d{0,18}$/.test(userId)) throw new ApiError('Invalid profile', 400, 'invalid_id');
  const result = await getPool().query(`select p.photo_bytes from user_social_profiles p
    join app_users u on u.id=p.user_id
    where p.user_id=$1 and u.company_id=$2 and u.approval_status='approved'`, [userId, session.company_id]);
  if (!result.rows[0]?.photo_bytes) throw new ApiError('Photo not found', 404, 'not_found');
  return result.rows[0].photo_bytes;
}
