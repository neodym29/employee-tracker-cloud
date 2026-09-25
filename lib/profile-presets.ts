export const PROFILE_PRESETS = [
  { id: 'sun', label: 'Sun', emoji: '☀️', color: '#f8d88b' },
  { id: 'moon', label: 'Moon', emoji: '🌙', color: '#c9d8fa' },
  { id: 'fox', label: 'Fox', emoji: '🦊', color: '#f6c7a4' },
  { id: 'cat', label: 'Cat', emoji: '🐱', color: '#ebd2bd' },
  { id: 'plant', label: 'Plant', emoji: '🌿', color: '#c6e6c9' },
  { id: 'planet', label: 'Planet', emoji: '🪐', color: '#dcd1f6' },
  { id: 'wave', label: 'Wave', emoji: '🌊', color: '#b8e4ee' },
  { id: 'spark', label: 'Spark', emoji: '✨', color: '#f4d8ed' },
] as const;

export type ProfilePresetId = (typeof PROFILE_PRESETS)[number]['id'];

export function profilePreset(id: string | null | undefined) {
  return PROFILE_PRESETS.find((preset) => preset.id === id) || null;
}
