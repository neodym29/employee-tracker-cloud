export const PROFILE_PRESETS = [
  { id: 'masked-knight', label: 'Masked Knight', image: '/avatars/masked-knight.webp', category: 'Games' },
  { id: 'ink-demon', label: 'Ink Demon', image: '/avatars/ink-demon.webp', category: 'Games' },
  { id: 'arcane-fighter', label: 'Arcane Fighter', image: '/avatars/arcane-fighter.webp', category: 'Games' },
  { id: 'ada-wong', label: 'Ada Wong', image: '/avatars/ada-wong.webp', category: 'Games' },
  { id: 'neon-ronin', label: 'Neon Ronin', image: '/avatars/neon-ronin.webp', category: 'Games' },
  { id: 'kratos', label: 'Kratos', image: '/avatars/kratos.webp', category: 'Games' },
  { id: 'lara-croft', label: 'Lara Croft', image: '/avatars/lara-croft.webp', category: 'Games' },
  { id: 'leon-kennedy', label: 'Leon S. Kennedy', image: '/avatars/leon-kennedy.webp', category: 'Games' },
  { id: 'aloy', label: 'Aloy', image: '/avatars/aloy.webp', category: 'Games' },
  { id: 'sephiroth', label: 'Sephiroth', image: '/avatars/sephiroth.webp', category: 'Games' },
  { id: 'lady-dimitrescu', label: 'Lady Dimitrescu', image: '/avatars/lady-dimitrescu.webp', category: 'Games' },
  { id: 'cj-johnson', label: 'CJ (GTA)', image: '/avatars/cj-johnson.webp', category: 'Games' },
  { id: 'trevor-philips', label: 'Trevor (GTA)', image: '/avatars/trevor-philips.webp', category: 'Games' },
  { id: 'malenia', label: 'Malenia', image: '/avatars/malenia.webp', category: 'Games' },
  { id: 'ranni', label: 'Ranni', image: '/avatars/ranni.webp', category: 'Games' },
  { id: 'gojo', label: 'Gojo', image: '/avatars/gojo.webp', category: 'Anime' },
  { id: 'itachi', label: 'Itachi', image: '/avatars/itachi.webp', category: 'Anime' },
  { id: 'levi', label: 'Levi', image: '/avatars/levi.webp', category: 'Anime' },
  { id: 'spike', label: 'Spike', image: '/avatars/spike.webp', category: 'Anime' },
  { id: 'guts', label: 'Guts', image: '/avatars/guts.webp', category: 'Anime' },
  { id: 'yumeko-jabami', label: 'Yumeko Jabami', image: '/avatars/yumeko-jabami.webp', category: 'Anime' },
  { id: 'mary-saotome', label: 'Mary Saotome', image: '/avatars/mary-saotome.webp', category: 'Anime' },
  { id: 'kirari-momobami', label: 'Kirari Momobami', image: '/avatars/kirari-momobami.webp', category: 'Anime' },
  { id: 'ririka-momobami', label: 'Ririka Momobami', image: '/avatars/ririka-momobami.webp', category: 'Anime' },
  { id: 'midari-ikishima', label: 'Midari Ikishima', image: '/avatars/midari-ikishima.webp', category: 'Anime' },
  { id: 'violet-fox', label: 'Violet Fox', image: '/avatars/violet-fox.webp', category: 'Cartoons' },
  { id: 'teal-mechanic', label: 'Teal Mechanic', image: '/avatars/teal-mechanic.webp', category: 'Cartoons' },
  { id: 'midnight-owl', label: 'Midnight Owl', image: '/avatars/midnight-owl.webp', category: 'Cartoons' },
] as const;

export type ProfilePresetId = (typeof PROFILE_PRESETS)[number]['id'];

export function profilePreset(id: string | null | undefined) {
  return PROFILE_PRESETS.find((preset) => preset.id === id) || null;
}
