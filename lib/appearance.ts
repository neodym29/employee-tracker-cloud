export const APPEARANCE_THEMES = [
  { id: 'classic', label: 'Classic', swatch: '#f4f2ed' },
  { id: 'lavender', label: 'Lavender', swatch: '#e7e2fa' },
  { id: 'ocean', label: 'Ocean', swatch: '#dceef2' },
  { id: 'forest', label: 'Forest', swatch: '#e1eee4' },
  { id: 'sunset', label: 'Sunset', swatch: '#f8e5df' },
  { id: 'night', label: 'Dark', swatch: '#242632' },
] as const;

export const APPEARANCE_FONTS = [
  { id: 'system', label: 'Standard', sample: 'Clean and familiar' },
  { id: 'readable', label: 'Readable', sample: 'Roomier letter shapes' },
  { id: 'editorial', label: 'Editorial', sample: 'A softer serif style' },
  { id: 'mono', label: 'Mono', sample: 'A developer feel' },
  { id: 'rounded', label: 'Rounded', sample: 'Soft and friendly' },
  { id: 'humanist', label: 'Humanist', sample: 'Open and balanced' },
  { id: 'compact', label: 'Compact', sample: 'More on screen' },
] as const;

export const APPEARANCE_SIZES = [
  { id: 'small', label: 'Small' },
  { id: 'normal', label: 'Default' },
  { id: 'large', label: 'Large' },
  { id: 'extra-large', label: 'Extra large' },
] as const;

export type AppearanceTheme = (typeof APPEARANCE_THEMES)[number]['id'];
export type AppearanceFont = (typeof APPEARANCE_FONTS)[number]['id'];
export type AppearanceSize = (typeof APPEARANCE_SIZES)[number]['id'];
export type Appearance = { theme: AppearanceTheme; font: AppearanceFont; size: AppearanceSize };

export const DEFAULT_APPEARANCE: Appearance = { theme: 'classic', font: 'system', size: 'normal' };

export function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return APPEARANCE_THEMES.some(option => option.id === value);
}

export function isAppearanceFont(value: unknown): value is AppearanceFont {
  return APPEARANCE_FONTS.some(option => option.id === value);
}

export function isAppearanceSize(value: unknown): value is AppearanceSize {
  return APPEARANCE_SIZES.some(option => option.id === value);
}
