import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [new URL('../lib/profiles.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', platform: 'node', write: false,
  plugins: [{
    name: 'profile-test-dependencies',
    setup(plugin) {
      plugin.onResolve({ filter: /^(\.\/(api|db)|sharp)$/ }, ({ path }) => ({ path, namespace: 'profile-test' }));
      plugin.onLoad({ filter: /.*/, namespace: 'profile-test' }, ({ path }) => ({
        contents: path === './db'
          ? 'export function getPool() { return globalThis.__profileTestPool; }'
          : path === 'sharp'
            ? 'export default function sharp(input) { globalThis.__profileTestImage = input; return { rotate() { return this; }, resize() { return this; }, webp() { return this; }, async toBuffer() { return Buffer.from("processed-webp"); } }; }'
            : 'export class ApiError extends Error { constructor(message,status,code) { super(message); this.status=status; this.code=code; } }',
        loader: 'js',
      }));
    },
  }],
});
const profiles = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const session = { id: '12', company_id: '1', account_type: 'engineer' };
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(30)]);

function poolFor(profile = { id: '12', name: 'Ibrahim', avatarKind: 'initials' }) {
  const queries = [];
  const query = async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('from app_users u left join user_social_profiles')) return { rows: [profile] };
    if (sql.includes('photo_bytes is not null as has_photo')) return { rows: [{ has_photo: true }] };
    if (sql.includes('select p.photo_bytes')) return { rows: [{ photo_bytes: Buffer.from('processed-webp') }] };
    return { rows: [] };
  };
  globalThis.__profileTestPool = { query, async connect() { return { query, release() {} }; } };
  return queries;
}

test('profile choices reject unknown avatars and control characters', async () => {
  poolFor();
  await assert.rejects(profiles.updateOwnProfile(session, { name: 'Ibrahim', bio: '', statusText: '', avatarKind: 'preset', avatarPreset: 'unknown' }), error => error.status === 400);
  await assert.rejects(profiles.updateOwnProfile(session, { name: 'Ibrahim', bio: '', statusText: '', avatarKind: 'preset', avatarPreset: 'sun' }), error => error.status === 400);
  await assert.rejects(profiles.updateOwnProfile(session, { name: 'Ibrahim\u0000', bio: '', statusText: '', avatarKind: 'initials' }), error => error.status === 400);
});

test('profile edits update only the authenticated account and allow a short multiline bio', async () => {
  const queries = poolFor();
  await profiles.updateOwnProfile(session, { name: 'Ibrahim', bio: 'Engineer\nBuilding tools', statusText: 'At work', avatarKind: 'preset', avatarPreset: 'gojo' });
  const userUpdate = queries.find(item => item.sql.includes('update app_users set display_name'));
  const profileUpdate = queries.find(item => item.sql.includes('insert into user_social_profiles'));
  assert.deepEqual(userUpdate.params, ['12', 'Ibrahim', '1']);
  assert.deepEqual(profileUpdate.params, ['12', 'Engineer\nBuilding tools', 'At work', 'preset', 'gojo']);
  assert.ok(queries.some(item => item.sql === 'commit'));
});

test('new Kakegurui and game portraits are valid profile choices', async () => {
  for (const avatarPreset of ['yumeko-jabami', 'mary-saotome', 'kirari-momobami', 'ririka-momobami', 'midari-ikishima', 'kratos', 'lara-croft', 'leon-kennedy', 'aloy', 'sephiroth', 'lady-dimitrescu', 'cj-johnson', 'trevor-philips', 'malenia', 'ranni']) {
    const queries = poolFor();
    await profiles.updateOwnProfile(session, { name: 'Ibrahim', bio: '', statusText: '', avatarKind: 'preset', avatarPreset });
    const saved = queries.find(item => item.sql.includes('insert into user_social_profiles'));
    assert.equal(saved.params[4], avatarPreset);
  }
});

test('appearance is account-scoped and rejects unknown themes or fonts', async () => {
  const queries = poolFor();
  await assert.rejects(profiles.setOwnAppearance(session, { theme: 'unknown', font: 'system' }), error => error.status === 400);
  await assert.rejects(profiles.setOwnAppearance(session, { theme: 'forest', font: 'unknown' }), error => error.status === 400);
  await profiles.setOwnAppearance(session, { theme: 'ocean', font: 'editorial' });
  const write = queries.find(item => item.sql.includes('appearance_theme,appearance_font'));
  assert.deepEqual(write.params, ['12', 'ocean', 'editorial']);
});

test('photos require a supported format and are normalized before storage', async () => {
  const queries = poolFor();
  await assert.rejects(profiles.saveOwnPhoto(session, Buffer.from('not-an-image'), 'image/png'), error => error.status === 400);
  await profiles.saveOwnPhoto(session, png, 'image/png');
  const saved = queries.find(item => item.sql.includes('photo_bytes,photo_mime,avatar_updated_at'));
  assert.equal(saved.params[0], '12');
  assert.equal(saved.params[1].toString(), 'processed-webp');
  assert.deepEqual(globalThis.__profileTestImage, png);
});

test('photo reads require an approved Neo-Nexus account', async () => {
  const queries = poolFor();
  const photo = await profiles.getVisiblePhoto(session, '44');
  assert.equal(photo.toString(), 'processed-webp');
  const read = queries.find(item => item.sql.includes('select p.photo_bytes'));
  assert.deepEqual(read.params, ['44']);
  assert.match(read.sql, /u\.approval_status='approved'/);
});
