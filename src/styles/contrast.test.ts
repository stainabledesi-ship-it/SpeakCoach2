import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function variable(css: string, name: string): string {
  const match = css.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (!match) throw new Error(`Missing solid CSS token --${name}`);
  return match[1];
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('Calm Lagoon WCAG contrast', () => {
  const light = readFileSync(resolve(process.cwd(), 'src/styles/main.css'), 'utf8').split('/* ── Calm Lagoon: declutter pass')[0];
  const dark = readFileSync(resolve(process.cwd(), 'src/styles/dark-theme.css'), 'utf8');

  it.each([{ name: 'light', css: light }, { name: 'dark', css: dark }])('$name text and controls meet WCAG contrast', ({ css }) => {
    const text = variable(css, 'text-primary');
    const secondary = variable(css, 'text-secondary');
    const background = variable(css, 'bg-primary');
    const surface = variable(css, 'bg-surface');
    const accent = variable(css, 'accent');
    const onAccent = variable(css, 'on-accent');

    expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(secondary, surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(accent, surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(accent, onAccent)).toBeGreaterThanOrEqual(4.5);
  });
});
