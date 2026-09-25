export const APPEARANCE_THEMES = [
  { id: 'classic', label: 'Classic', swatch: '#f4f2ed' },
  { id: 'lavender', label: 'Lavender', swatch: '#e7e2fa' },
  { id: 'ocean', label: 'Ocean', swatch: '#dceef2' },
  { id: 'forest', label: 'Forest', swatch: '#e1eee4' },
  { id: 'sunset', label: 'Sunset', swatch: '#f8e5df' },
] as const;

export const APPEARANCE_FONTS = [
  { id: 'system', label: 'Standard', sample: 'Clean and familiar' },
  { id: 'readable', label: 'Readable', sample: 'Roomier letter shapes' },
  { id: 'editorial', label: 'Editorial', sample: 'A softer serif style' },
  { id: 'mono', label: 'Mono', sample: 'A developer feel' },
] as const;

export type AppearanceTheme = (typeof APPEARANCE_THEMES)[number]['id'];
export type AppearanceFont = (typeof APPEARANCE_FONTS)[number]['id'];
export type Appearance = { theme: AppearanceTheme; font: AppearanceFont };

export const DEFAULT_APPEARANCE: Appearance = { theme: 'classic', font: 'system' };

export function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return APPEARANCE_THEMES.some(option => option.id === value);
}

export function isAppearanceFont(value: unknown): value is AppearanceFont {
  return APPEARANCE_FONTS.some(option => option.id === value);
}
