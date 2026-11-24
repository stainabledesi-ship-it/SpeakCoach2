import { SHADOWING_BANK_DATA } from './shadowingBankData';

export type ShadowingDifficulty = 'easy' | 'medium' | 'hard';

export interface ReferenceWordTiming {
  word: string;
  normalized: string;
  expectedStartMs: number;
  expectedDurationMs: number;
}

export interface ShadowingSentence {
  id: string;
  difficulty: ShadowingDifficulty;
  topic: string;
  text: string;
  phoneticFocus: string;
  expectedTotalDurationMs: number;
  speakingTip?: string;
  meaningContext?: string;
  usefulVocabulary?: { term: string; meaning: string }[];
}

export const BUILTIN_SHADOWING_SENTENCES: ShadowingSentence[] = (SHADOWING_BANK_DATA as unknown as { value: ShadowingSentence[] }[]).flatMap(group => group.value);

export function normalizeWord(raw: string): string {
  return raw.normalize('NFKC')
    .replace(/[’‘ʼ´`]/gu, "'")
    .replace(/[‐‑‒–—―−]/gu, '-')
    .replace(/[٠-٩۰-۹]/gu, digit => {
      const arabic = '٠١٢٣٤٥٦٧٨٩'.indexOf(digit);
      return String(arabic >= 0 ? arabic : '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit));
    })
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')
    .trim();
}

export function tokenizeSentenceWords(text: string): { display: string; normalized: string }[] {
  return text
    .trim()
    .split(/\s+/)
    .map((display) => ({
      display,
      normalized: normalizeWord(display)
    }))
    .filter((w) => w.normalized.length > 0);
}

export function buildReferenceWordTimings(
  text: string,
  totalDurationMs = 4000
): ReferenceWordTiming[] {
  const tokens = tokenizeSentenceWords(text);
  if (tokens.length === 0) return [];

  const weights = tokens.map((t) => Math.max(2, t.normalized.length));
  const totalWeight = weights.reduce((acc, w) => acc + w, 0);

  let cursorMs = 0;
  return tokens.map((token, idx) => {
    const share = weights[idx] / totalWeight;
    const duration = Math.max(140, Math.round(totalDurationMs * share));
    const entry: ReferenceWordTiming = {
      word: token.display,
      normalized: token.normalized,
      expectedStartMs: cursorMs,
      expectedDurationMs: duration
    };
    cursorMs += duration;
    return entry;
  });
}

export function getShadowingSentencesByDifficulty(
  difficulty?: ShadowingDifficulty
): ShadowingSentence[] {
  if (!difficulty) return BUILTIN_SHADOWING_SENTENCES;
  return BUILTIN_SHADOWING_SENTENCES.filter((s) => s.difficulty === difficulty);
}
