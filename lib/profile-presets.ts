export const PROFILE_PRESETS = [
  { id: 'masked-knight', label: 'Masked Knight', image: '/avatars/masked-knight.webp', category: 'Games' },
  { id: 'ink-demon', label: 'Ink Demon', image: '/avatars/ink-demon.webp', category: 'Games' },
  { id: 'arcane-fighter', label: 'Arcane Fighter', image: '/avatars/arcane-fighter.webp', category: 'Games' },
  { id: 'ada-wong', label: 'Ada Wong', image: '/avatars/ada-wong.webp', category: 'Games' },
  { id: 'neon-ronin', label: 'Neon Ronin', image: '/avatars/neon-ronin.webp', category: 'Games' },
  { id: 'gojo', label: 'Gojo', image: '/avatars/gojo.webp', category: 'Anime' },
  { id: 'itachi', label: 'Itachi', image: '/avatars/itachi.webp', category: 'Anime' },
  { id: 'levi', label: 'Levi', image: '/avatars/levi.webp', category: 'Anime' },
  { id: 'spike', label: 'Spike', image: '/avatars/spike.webp', category: 'Anime' },
  { id: 'guts', label: 'Guts', image: '/avatars/guts.webp', category: 'Anime' },
] as const;

export type ProfilePresetId = (typeof PROFILE_PRESETS)[number]['id'];

export function profilePreset(id: string | null | undefined) {
  return PROFILE_PRESETS.find((preset) => preset.id === id) || null;
}
