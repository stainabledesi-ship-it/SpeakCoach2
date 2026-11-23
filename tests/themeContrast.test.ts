import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function readTokenBlock(css: string, selector: RegExp): Record<string, string> {
  const block = css.match(selector)?.[1];
  if (!block) throw new Error('Theme token block was not found.');
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)]
      .map((match) => [match[1], match[2]])
  );
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function oklchHue(hex: string): number {
  const srgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = srgb.map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = linear;
  const l = Math.cbrt(0.4122214708*r + 0.5363325363*g + 0.0514459929*b);
  const m = Math.cbrt(0.2119034982*r + 0.6806995451*g + 0.1073969566*b);
  const s = Math.cbrt(0.0883024619*r + 0.2817188376*g + 0.6299787005*b);
  const a = 1.9779984951*l - 2.428592205*m + 0.4505937099*s;
  const bb = 0.0259040371*l + 0.7827717662*m - 0.808675766*s;
  return (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360;
}

function hueDistance(a: number, b: number): number {
  const distance = Math.abs(a - b) % 360;
  return Math.min(distance, 360 - distance);
}

function getChipRule(css: string, state: string): string {
  const start = css.indexOf('.word-chip.' + state);
  if (start < 0) return '';
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return open < 0 || close < 0 ? '' : css.slice(open + 1, close);
}

describe('theme contrast and semantic palette', () => {
  const lightCss = readFileSync('src/styles/main.css', 'utf8');
  const darkCss = readFileSync('src/styles/dark-theme.css', 'utf8');
  const themes = [
    { name: 'light', tokens: readTokenBlock(lightCss, /:root\s*\{([^}]+)\}/), dangerForeground: '#FFFFFF' },
    { name: 'dark', tokens: readTokenBlock(darkCss, /html\[data-theme="dark"\]\s*\{([^}]+)\}/), dangerForeground: '#111814' }
  ];

  it.each(themes)('$name primary, secondary and muted text meet WCAG AA on both main surfaces', ({ tokens }) => {
    for (const foreground of ['--text-primary', '--text-secondary', '--text-muted', '--success', '--warning', '--danger', '--neutral-chip']) {
      for (const background of ['--bg-primary', '--bg-surface']) {
        expect(contrastRatio(tokens[foreground], tokens[background]), foreground + ' on ' + background).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(themes)('$name defines all required semantic tokens', ({ tokens }) => {
    for (const token of ['--bg-raised', '--on-accent', '--neutral-chip']) {
      expect(tokens[token], token).toBeTruthy();
    }
  });

  it('uses a plain charcoal canvas for unframed dark-mode pages', () => {
    expect(darkCss).toContain('background-color:var(--bg-primary)');
    expect(darkCss).toContain('background:#17191C !important');
    expect(darkCss).not.toMatch(/gradient\s*\(/);
  });

  it('uses semantic status tokens for word chips and avoids decorative dark gradients/shadows', () => {
    for (const selector of ['.word-chip.match', '.word-chip.mispronounced', '.word-chip.missing', '.word-chip.extra']) {
      expect(lightCss).toContain(selector);
      expect(darkCss).toContain(selector);
    }
    expect(darkCss).not.toMatch(/gradient\s*\(/);
    expect(darkCss).not.toMatch(/box-shadow\s*:\s*(?!\s*none\b)[^;]+;/);
  });

  it('uses 15 percent semantic chip fills and 38 percent semantic chip borders', () => {
    for (const css of [lightCss, darkCss]) {
      for (const [state, token] of [['match', 'success'], ['mispronounced', 'warning'], ['missing', 'danger'], ['extra', 'neutral-chip']]) {
        const rule = getChipRule(css, state);
        expect(rule).toContain('color-mix(in srgb, var(--' + token + ') 15%, transparent)');
        expect(rule).toContain('color-mix(in srgb, var(--' + token + ') 38%, transparent)');
      }
    }
  });

  it.each(themes)('$name primary action text meets WCAG AA', ({ tokens }) => {
    expect(contrastRatio(tokens['--on-accent'], tokens['--accent'])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(themes)('$name danger action text meets WCAG AA', ({ tokens, dangerForeground }) => {
    expect(contrastRatio(dangerForeground, tokens['--danger'])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(themes)('$name accent hue remains distinct from status colors', ({ tokens }) => {
    const accentHue = oklchHue(tokens['--accent']);
    for (const status of ['--success', '--warning', '--danger']) {
      expect(hueDistance(accentHue, oklchHue(tokens[status])), 'accent vs ' + status).toBeGreaterThanOrEqual(60);
    }
  });

  it('keeps individual IELTS history delete controls at the 48px minimum touch target', () => {
    expect(lightCss).toMatch(/\.history-delete-btn\s*\{[^}]*min-height:\s*48px/s);
  });
});
