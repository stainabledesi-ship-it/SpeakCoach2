import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_SHADOWING_SETS } from '../src/data/shadowingSentenceSets';
import {
  appendShadowingSet,
  getActiveShadowingSet,
  loadShadowingSetHistory,
  moveShadowingSet,
  saveShadowingSetHistory,
  selectShadowingSentence,
  type ShadowingSetHistory
} from '../src/services/shadowingSetHistory';

const memory = vi.hoisted(() => new Map<string, string>());
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: memory.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => { memory.set(key, value); }
  }
}));

describe('Shadowing sentence-set history', () => {
  beforeEach(() => { memory.clear(); localStorage.clear(); });

  it('provides five offline sets of twenty unique sentences for each difficulty', () => {
    const all = Object.values(BUILTIN_SHADOWING_SETS).flat(2);
    expect(all).toHaveLength(300);
    expect(new Set(all.map(sentence => sentence.text.toLocaleLowerCase())).size).toBe(300);
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      expect(BUILTIN_SHADOWING_SETS[difficulty]).toHaveLength(5);
      expect(new Set(BUILTIN_SHADOWING_SETS[difficulty].map(set => set[0].topic)).size).toBe(5);
      for (const set of BUILTIN_SHADOWING_SETS[difficulty]) {
        expect(set.every(sentence => sentence.topic === set[0].topic)).toBe(true);
        expect(set).toHaveLength(20);
        expect(new Set(set.map(sentence => sentence.text)).size).toBe(20);
        expect(set.every(sentence => sentence.text.trim().length > 0)).toBe(true);
      }
    }
  });

  it('migrates the previously saved AI batch into the unified history', async () => {
    const legacy = BUILTIN_SHADOWING_SETS.easy[0].map((sentence, index) => ({
      ...sentence,
      id: `legacy-ai-${index}`,
      text: `A previously generated sentence number ${index + 1} remains available.`,
      providerName: 'Legacy provider',
      modelName: 'legacy-model'
    }));
    localStorage.setItem('speakcoach_shadowing_active_set_v1', JSON.stringify(legacy));
    const history = await loadShadowingSetHistory();
    expect(history.easy.sets).toHaveLength(6);
    expect(history.easy.sets.at(-1)?.source).toBe('ai');
    expect(getActiveShadowingSet(history, 'easy').sentences[0].text).toContain('previously generated');
    expect(localStorage.getItem('speakcoach_shadowing_active_set_v1')).toBeNull();
  });

  it('seeds history once and restores the active sentence position after reload', async () => {
    let history = await loadShadowingSetHistory();
    expect(history.easy.sets).toHaveLength(5);
    history = selectShadowingSentence(history, 'easy', 7);
    await saveShadowingSetHistory(history);

    const restored = await loadShadowingSetHistory();
    expect(restored.easy.activeSentenceIndex).toBe(7);
    expect(getActiveShadowingSet(restored, 'easy').sentences[7].id).toBe(BUILTIN_SHADOWING_SETS.easy[0][7].id);
  });

  it('adds generated sets to the same history and keeps at most ten per difficulty', async () => {
    let history: ShadowingSetHistory = await loadShadowingSetHistory();
    for (let i = 1; i <= 7; i++) {
      const batch = BUILTIN_SHADOWING_SETS.medium[0].map((sentence, index) => ({
        ...sentence,
        id: `generated-${i}-${index}`,
        text: `Generated set ${i}, sentence ${index + 1} is ready for practice.`
      }));
      history = appendShadowingSet(history, 'medium', batch, `generated-set-${i}`);
    }
    expect(history.medium.sets).toHaveLength(10);
    expect(history.medium.sets[0].source).toBe('builtin');
    expect(history.medium.sets.at(-1)?.source).toBe('ai');
    expect(history.medium.activeSetId).toBe('generated-set-7');
    expect(history.medium.activeSentenceIndex).toBe(0);
    await saveShadowingSetHistory(history);
    const restored = await loadShadowingSetHistory();
    expect(restored.medium.sets).toHaveLength(10);
    expect(restored.medium.activeSetId).toBe('generated-set-7');
  });

  it('moves through history without changing the sentence content or generating a set', async () => {
    const history = await loadShadowingSetHistory();
    const older = moveShadowingSet(history, 'hard', 1);
    expect(getActiveShadowingSet(older, 'hard').id).toBe('builtin-hard-2');
    const newer = moveShadowingSet(older, 'hard', -1);
    expect(getActiveShadowingSet(newer, 'hard').id).toBe('builtin-hard-1');
    expect(newer.hard.sets).toHaveLength(5);
  });
});
