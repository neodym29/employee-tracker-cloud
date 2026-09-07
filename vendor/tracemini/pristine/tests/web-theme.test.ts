import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import {normalizeTheme, nextTheme, themeToggleLabel, themeColor} from '../apps/web/theme.js';

describe('web theme preference', () => {
  it('restores only supported persisted themes', () => {
    expect(normalizeTheme('night')).toBe('night');
    expect(normalizeTheme('day')).toBe('day');
    expect(normalizeTheme('unexpected')).toBe('day');
    expect(normalizeTheme(null)).toBe('day');
  });

  it('describes and applies the opposite mode through an accessible toggle', () => {
    expect(nextTheme('day')).toBe('night');
    expect(themeToggleLabel('day')).toBe('Switch to night mode');
    expect(nextTheme('night')).toBe('day');
    expect(themeToggleLabel('night')).toBe('Switch to day mode');
  });

  it('provides browser chrome colors for both modes', () => {
    expect(themeColor('day')).toBe('#eef0e9');
    expect(themeColor('night')).toBe('#05070a');
  });

  it('uses the big Trace Terminal Noir palette', () => {
    const css = fs.readFileSync(new URL('../apps/web/style.css', import.meta.url), 'utf8');
    for (const token of ['--canvas:#05070a', '--surface:#0a0e13', '--line:#1c2733', '--signal:#19df91']) expect(css).toContain(token);
    expect(css).toContain('radial-gradient(circle at 78% 0');
    expect(css).toContain('box-shadow:inset 2px 0 var(--signal)');
    expect(css).toContain('input:-webkit-autofill');
    expect(css).toContain('-webkit-text-fill-color:var(--ink)');
    expect(css).toContain('@media(max-width:480px){.sidebar{grid-template-columns:1fr}.sidebar nav{grid-column:auto}.workspace-select{grid-row:auto}');
  });
});
