import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildReferenceWordTimings,
  BUILTIN_SHADOWING_SENTENCES,
  getShadowingSentencesByDifficulty
} from '../src/data/shadowingBank';
import {
  clearMemoryAudioCache,
  computeAudioCacheHash,
  getCachedTtsAudio,
  setCachedTtsAudio
} from '../src/services/audioCache';

describe('Shadowing Sentence Bank & Audio Hash Cache', () => {
  beforeEach(() => {
    localStorage.clear();
    clearMemoryAudioCache();
  });

  it('provides graded shadowing sentences across easy, medium, and hard levels', () => {
    expect(BUILTIN_SHADOWING_SENTENCES).toHaveLength(300);
    expect(new Set(BUILTIN_SHADOWING_SENTENCES.map(sentence => sentence.text)).size).toBe(300);
    expect(BUILTIN_SHADOWING_SENTENCES.every(sentence => !/[ةث™ˆھتگŒƒأ¦ٹ‘إ‹œ]/u.test(sentence.phoneticFocus))).toBe(true);
    expect(getShadowingSentencesByDifficulty('easy').length).toBeGreaterThanOrEqual(8);
    expect(getShadowingSentencesByDifficulty('medium').length).toBeGreaterThanOrEqual(8);
    expect(getShadowingSentencesByDifficulty('hard').length).toBeGreaterThanOrEqual(8);
  });

  it('builds proportional reference word timings for a sentence', () => {
    const timings = buildReferenceWordTimings('She has been studying computer science.', 3000);
    expect(timings).toHaveLength(6);
    expect(timings[0].normalized).toBe('she');
    expect(timings[4].normalized).toBe('computer');
    // Longer word "computer" should have a longer expected duration than "she"
    expect(timings[4].expectedDurationMs).toBeGreaterThan(timings[0].expectedDurationMs);
  });

  it('computes deterministic hash(text+voice+rate) and caches audio payloads', async () => {
    const h1 = computeAudioCacheHash({
      providerId: 'openai_tts',
      voiceOrModel: 'tts-1:alloy',
      rate: 1.0,
      text: 'Hello world'
    });
    const h2 = computeAudioCacheHash({
      providerId: 'openai_tts',
      voiceOrModel: 'tts-1:nova',
      rate: 1.0,
      text: 'Hello world'
    });
    expect(h1).toHaveLength(16);
    expect(h1).not.toBe(h2);

    await setCachedTtsAudio(h1, 'data:audio/mp3;base64,AAAA');
    const loaded = await getCachedTtsAudio(h1);
    expect(loaded).toBe('data:audio/mp3;base64,AAAA');
  });
});
