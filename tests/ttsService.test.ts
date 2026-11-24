import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllProviderAccountHealth, markProviderAccountFailure } from '../src/services/providerHealth';
import { clearMemoryAudioCache, computeAudioCacheHash, createAudioCacheAccountFingerprint } from '../src/services/audioCache';
import { activateShadowingAudioSet, readActiveShadowingAudio, resetShadowingAudioStoreForTests } from '../src/services/shadowingAudioStore';
import { networkMonitor } from '../src/services/networkMonitor';
import { clearAllRuntimeFailures } from '../src/services/tierManager';
import {
  playAudioDataUrl,
  speakOfflineNativeTts,
  speakSentenceWithTierFallback,
  synthesizeOnlineNeuralAudio,
  preloadSentenceAudio,
  clearPreloadedSentenceAudio,
  clearGeminiLanguageFailures
} from '../src/services/ttsService';
import { IeltsSessionController } from '../src/services/ieltsSessionEngine';
import { generateIeltsSessionPlan } from './fixtures/legacyIeltsQuestionBank';
import { audioRecorder } from '../src/services/audioRecorder';
import { saveApiKey } from '../src/storage/keyStore';
import { saveSlotConfig, saveSlotConnectionTestResult } from '../src/storage/localStore';

describe('Voice TTS Service (Online Neural Caching + Offline Native Fallback)', () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearAllProviderAccountHealth();
    clearMemoryAudioCache();
    resetShadowingAudioStoreForTests();
    clearGeminiLanguageFailures();
    clearAllRuntimeFailures();
    networkMonitor.setOnline(true);
  });

  it('uses Tier 3 Android Native TTS when no API key is configured', async () => {
    const res = await speakSentenceWithTierFallback(
      'I usually start my morning with a cup of hot coffee.',
      { rate: 1.0 }
    );
    expect(res.activeTier.tier).toBe(3);
    expect(res.activeTier.label).toBe('Basic offline');
    expect(res.fromCache).toBe(false);
    expect(res.durationEstimateMs).toBeGreaterThan(2000);
  });

  it('synthesizes online neural TTS and serves subsequent replays from local hash cache', async () => {
    await saveSlotConfig({
      slotId: 'voice_tts',
      providerId: 'openai_tts',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'tts-1:alloy'
    });
    await saveApiKey('voice_tts', 'openai_tts', 'sk-tts-live');
    await saveSlotConnectionTestResult('voice_tts', {
      ok: true, slotId: 'voice_tts', providerId: 'openai_tts', tier: 1,
      label: 'Online AI', latencyMs: 1, message: 'PASS — test fixture'
    });

    let networkCalls = 0;
    const mockTransport = async (opts: { url: string }) => {
      networkCalls++;
      return {
        url: opts.url,
        status: 200,
        headers: {},
        data: 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA'
      };
    };

    const first = await speakSentenceWithTierFallback('Practice makes perfect.', {
      rate: 1.0,
      transport: mockTransport
    });
    expect(first.activeTier.tier).toBe(1);
    expect(first.activeTier.label).toBe('Online AI');
    expect(first.fromCache).toBe(false);
    expect(networkCalls).toBe(1);

    const second = await speakSentenceWithTierFallback('Practice makes perfect.', {
      rate: 1.0,
      transport: mockTransport
    });
    expect(second.activeTier.tier).toBe(1);
    expect(second.fromCache).toBe(true);
    expect(networkCalls).toBe(1); // Zero extra network calls!
  });


  it('persists generated audio from every supported online TTS provider into the active set', async () => {
    const mp3 = 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA';
    const providers = [
      { providerId: 'openai_tts', baseUrl: 'https://api.openai.com/v1', modelOrVoice: 'tts-1:alloy' },
      { providerId: 'azure_tts', baseUrl: 'https://eastus.tts.speech.microsoft.com', modelOrVoice: 'en-US-JennyNeural' },
      { providerId: 'elevenlabs_tts', baseUrl: 'https://api.elevenlabs.io/v1', modelOrVoice: 'voice-id:eleven_multilingual_v2' },
      { providerId: 'gemini_tts', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelOrVoice: 'gemini-2.5-flash-preview-tts', customTtsVoice: 'Puck' }
    ] as const;

    for (const config of providers) {
      const setId = `en:easy:provider-${config.providerId}`;
      const generation = await activateShadowingAudioSet(setId);
      const transport = async (opts: { url: string }) => ({
        url: opts.url,
        status: 200,
        headers: {},
        data: config.providerId === 'gemini_tts'
          ? { candidates: [{ content: { parts: [{ inlineData: { data: 'UklGRg==', mimeType: 'audio/wav' } }] } }] }
          : mp3
      });
      const result = await synthesizeOnlineNeuralAudio(
        `Persist audio for ${config.providerId}.`,
        { slotId: 'voice_tts', ...config },
        `key-${config.providerId}`,
        1,
        transport,
        'en-US',
        false,
        undefined,
        false,
        15000,
        { setId, generation, kind: 'sentence' }
      );
      expect(result.persistedToActiveSet, config.providerId).toBe(true);
      await expect(readActiveShadowingAudio(result.cacheHash, setId)).resolves.toBeTruthy();
    }
  });

  it('uses the selected custom voice in the request and keeps different voices out of the same cache entry', async () => {
    const requests: any[] = [];
    const transport = async (opts: any) => {
      requests.push(opts.data);
      return {
        url: opts.url, status: 200, headers: {},
        data: 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA'
      };
    };
    const baseConfig = {
      slotId: 'voice_tts' as const,
      providerId: 'openai_tts',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'tts-1'
    };

    await synthesizeOnlineNeuralAudio('A different voice should be cached separately.', baseConfig, 'key', 1, transport);
    await synthesizeOnlineNeuralAudio('A different voice should be cached separately.', {
      ...baseConfig, customTtsVoice: 'shimmer'
    }, 'key', 1, transport);

    expect(requests.map((request) => request.voice)).toEqual(['alloy', 'shimmer']);
  });

  it('uses the selected API 2 Azure voice override in SSML', async () => {
    let requestBody = '';
    await synthesizeOnlineNeuralAudio('Hello from API 2.', {
      slotId: 'voice_tts',
      providerId: 'azure_tts',
      baseUrl: 'https://eastus.tts.speech.microsoft.com',
      modelOrVoice: 'en-US-JennyNeural',
      customTtsVoice: 'en-US-AriaNeural'
    }, 'azure-key', 1, async (opts: any) => {
      requestBody = String(opts.data);
      return {
        url: opts.url, status: 200, headers: {},
        data: 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA'
      };
    });

    expect(requestBody).toContain('<voice name=\'en-US-AriaNeural\'>');
  });

  it('uses the selected API 2 ElevenLabs voice ID override', async () => {
    let requestedUrl = '';
    await synthesizeOnlineNeuralAudio('Hello from API 2.', {
      slotId: 'voice_tts',
      providerId: 'elevenlabs_tts',
      baseUrl: 'https://api.elevenlabs.io/v1',
      modelOrVoice: 'old-voice-id:eleven_multilingual_v2',
      customTtsVoice: 'selected-voice-id'
    }, 'eleven-key', 1, async (opts: any) => {
      requestedUrl = opts.url;
      return {
        url: opts.url, status: 200, headers: {},
        data: 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA'
      };
    });

    expect(requestedUrl).toContain('/text-to-speech/selected-voice-id');
  });

  it('automatically falls back to Tier 3 Native TTS if the online TTS endpoint fails', async () => {
    await saveSlotConfig({
      slotId: 'voice_tts',
      providerId: 'azure_tts',
      baseUrl: 'https://eastus.tts.speech.microsoft.com',
      modelOrVoice: 'en-US-JennyNeural'
    });
    await saveApiKey('voice_tts', 'azure_tts', 'bad-key');
    await saveSlotConnectionTestResult('voice_tts', {
      ok: true, slotId: 'voice_tts', providerId: 'azure_tts', tier: 1,
      label: 'Online AI', latencyMs: 1, message: 'PASS — test fixture'
    });

    const res = await speakSentenceWithTierFallback('Fallback test sentence.', {
      rate: 0.72,
      transport: async (opts) => ({
        url: opts.url,
        status: 401,
        headers: {},
        data: 'Unauthorized'
      })
    });

    expect(res.activeTier.tier).toBe(3);
    expect(res.activeTier.label).toBe('Basic offline');
    expect(res.activeTier.isFallback).toBe(true);
  });

  it('resolves playAudioDataUrl ONLY when audio finishes (onended/onerror), delaying IELTS cue beep and recording until playback ends (A2-2)', async () => {
    const OriginalAudio = globalThis.Audio;
    const OriginalSpeechSynth = window.speechSynthesis;
    const OriginalUtterance = globalThis.SpeechSynthesisUtterance;

    let triggerEnded: (() => void) | null = null;
    let triggerError: (() => void) | null = null;
    let playCalled = false;

    class MockAudio {
      public src: string;
      public playbackRate = 1.0;
      public onended: (() => void) | null = null;
      public onerror: (() => void) | null = null;
      private endedListeners: Array<() => void> = [];
      private errorListeners: Array<() => void> = [];

      constructor(src: string) {
        this.src = src;
        triggerEnded = () => {
          this.onended?.();
          this.endedListeners.forEach((fn) => fn());
        };
        triggerError = () => {
          this.onerror?.();
          this.errorListeners.forEach((fn) => fn());
        };
      }

      addEventListener(type: string, cb: () => void) {
        if (type === 'ended') this.endedListeners.push(cb);
        if (type === 'error') this.errorListeners.push(cb);
      }

      play(): Promise<void> {
        playCalled = true;
        return Promise.resolve();
      }

      pause() {}
    }

    (globalThis as unknown as { Audio: unknown }).Audio = MockAudio;

    try {
      // 1. Direct playAudioDataUrl waits for onended, NOT play() resolution
      let resolved = false;
      const playPromise = playAudioDataUrl('data:audio/mp3;base64,AAAA', 1.0).then(() => {
        resolved = true;
      });

      await new Promise((r) => setTimeout(r, 20));
      expect(playCalled).toBe(true);
      expect(resolved).toBe(false);

      triggerEnded!();
      await playPromise;
      expect(resolved).toBe(true);

      // 2. Also resolves cleanly on onerror
      let errorResolved = false;
      const errPromise = playAudioDataUrl('data:audio/mp3;base64,BBBB', 1.0).then(() => {
        errorResolved = true;
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(errorResolved).toBe(false);
      triggerError!();
      await errPromise;
      expect(errorResolved).toBe(true);

      // 3. IELTS examiner prompt: cue_tone and recording do NOT start until TTS audio finishes
      await saveSlotConfig({
        slotId: 'voice_tts',
        providerId: 'openai_tts',
        baseUrl: 'https://api.openai.com/v1',
        modelOrVoice: 'tts-1:alloy'
      });
      await saveApiKey('voice_tts', 'openai_tts', 'sk-tts-live');
      await saveSlotConnectionTestResult('voice_tts', {
        ok: true, slotId: 'voice_tts', providerId: 'openai_tts', tier: 1,
        label: 'Online AI', latencyMs: 1, message: 'PASS — test fixture'
      });

      const ctrl = new IeltsSessionController({ mode: 'part1', plan: generateIeltsSessionPlan() });
      const firstQuestion = ctrl.getSnapshot().currentStep!.questionText;

      // Pre-warm audio cache for firstQuestion using a fast ending mock audio
      const origCtor = (globalThis as unknown as { Audio: unknown }).Audio;
      (globalThis as unknown as { Audio: unknown }).Audio = class {
        public onended: (() => void) | null = null;
        play() {
          queueMicrotask(() => this.onended?.());
          return Promise.resolve();
        }
      };
      await speakSentenceWithTierFallback(firstQuestion, {
        rate: 1.0,
        transport: async (opts) => ({
          url: opts.url,
          status: 200,
          headers: {},
          data: 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA'
        })
      });
      (globalThis as unknown as { Audio: unknown }).Audio = origCtor;

      const promptPromise = ctrl.startStepExaminerPrompt();

      await new Promise((r) => setTimeout(r, 30));
      // While audio is still playing (onended not fired yet), status MUST remain examiner_speaking
      expect(ctrl.getSnapshot().status).toBe('examiner_speaking');
      expect(audioRecorder.isRecording()).toBe(false);

      // Now finish audio playback -> cue beep plays and recording starts
      triggerEnded!();
      await promptPromise;
      expect(ctrl.getSnapshot().activeVoiceTier?.tier).toBe(1);
      expect(ctrl.getSnapshot().activeVoiceTier?.providerId).toBe('openai_tts');
      expect(ctrl.getSnapshot().status).toBe('recording');
      expect(audioRecorder.isRecording()).toBe(true);
      await audioRecorder.stop();
      ctrl.clearAllTimers();

      // 4. Web speechSynthesis fallback also waits for utterance onend
      let utterEnd: (() => void) | null = null;
      (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
        class {
          public text: string;
          public lang = 'en-US';
          public rate = 1.0;
          public onend: (() => void) | null = null;
          public onerror: (() => void) | null = null;
          constructor(text: string) {
            this.text = text;
            utterEnd = () => this.onend?.();
          }
        };
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          cancel: () => {},
          speak: () => {}
        }
      });

      let synthResolved = false;
      const synthPromise = speakOfflineNativeTts('Hello world', 'en-US', 1.0).then(() => {
        synthResolved = true;
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(synthResolved).toBe(false);
      utterEnd!();
      await synthPromise;
      expect(synthResolved).toBe(true);
    } finally {
      (globalThis as unknown as { Audio: unknown }).Audio = OriginalAudio;
      (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
        OriginalUtterance;
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: OriginalSpeechSynth
      });
    }
  }, 15000);
  it('makes no prefetch request when the TTS slot resolves to Tier 3', async () => {
    let calls = 0;
    const ok = await preloadSentenceAudio('No online provider is configured.', {
      transport: async opts => {
        calls++;
        return { url: opts.url, status: 200, headers: {}, data: 'audio' };
      }
    });
    expect(ok).toBe(false);
    expect(calls).toBe(0);
  });

  it('shares one in-flight network request when playback overlaps prefetch for the same sentence', async () => {
    await saveSlotConfig({
      slotId: 'voice_tts',
      providerId: 'openai_tts',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'tts-1:alloy'
    });
    await saveApiKey('voice_tts', 'openai_tts', 'shared-inflight-key');
    await saveSlotConnectionTestResult('voice_tts', {
      ok: true, slotId: 'voice_tts', providerId: 'openai_tts', tier: 1,
      label: 'Online AI', latencyMs: 1, message: 'PASS — test fixture'
    });

    let calls = 0;
    let release: ((response: { url: string; status: number; headers: Record<string, string>; data: string }) => void) | undefined;
    const transport = async (_opts: { url: string }) => {
      calls++;
      return new Promise<{ url: string; status: number; headers: Record<string, string>; data: string }>(resolve => {
        release = resolve;
      });
    };
    vi.stubGlobal('Audio', undefined);
    try {
      const prefetch = preloadSentenceAudio('One shared in-flight sentence.', { transport });
      while (calls === 0) await new Promise(resolve => setTimeout(resolve, 0));
      const playback = speakSentenceWithTierFallback('One shared in-flight sentence.', { transport });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(calls).toBe(1);
      release?.({
        url: 'https://api.openai.com/v1/audio/speech',
        status: 200,
        headers: {},
        data: 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA'
      });
      expect(await prefetch).toBe(true);
      const result = await playback;
      expect(result.activeTier.tier).toBe(1);
      expect(calls).toBe(1);
    } finally {
      clearPreloadedSentenceAudio();
      vi.unstubAllGlobals();
    }
  });

  it('makes zero prefetch requests while the provider account is cooling down', async () => {
    const config = {
      slotId: 'voice_tts' as const,
      providerId: 'openai_tts',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'tts-1:alloy'
    };
    await saveSlotConfig(config);
    await saveApiKey('voice_tts', 'openai_tts', 'cooldown-prefetch-key');
    await saveSlotConnectionTestResult('voice_tts', {
      ok: true, slotId: 'voice_tts', providerId: 'openai_tts', tier: 1,
      label: 'Online AI', latencyMs: 1, message: 'PASS — test fixture'
    });
    await markProviderAccountFailure('voice_tts', 'primary', Object.assign(new Error('HTTP 429'), { status: 429 }));

    let calls = 0;
    const ok = await preloadSentenceAudio('Do not prefetch during cooldown.', {
      transport: async opts => {
        calls++;
        return { url: opts.url, status: 200, headers: {}, data: 'audio' };
      }
    });
    expect(ok).toBe(false);
    expect(calls).toBe(0);
  });

  it('does not start a different prefetch while user-initiated synthesis is in flight', async () => {
    const config = {
      slotId: 'voice_tts' as const,
      providerId: 'openai_tts',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'tts-1:alloy'
    };
    await saveSlotConfig(config);
    await saveApiKey('voice_tts', 'openai_tts', 'playback-priority-key');
    await saveSlotConnectionTestResult('voice_tts', {
      ok: true, slotId: 'voice_tts', providerId: 'openai_tts', tier: 1,
      label: 'Online AI', latencyMs: 1, message: 'PASS — test fixture'
    });

    let calls = 0;
    let release: ((response: { url: string; status: number; headers: Record<string, string>; data: string }) => void) | undefined;
    const transport = async (_opts: { url: string }) => {
      calls++;
      return new Promise<{ url: string; status: number; headers: Record<string, string>; data: string }>(resolve => {
        release = resolve;
      });
    };
    vi.stubGlobal('Audio', undefined);
    try {
      const playback = speakSentenceWithTierFallback('User requested this sentence now.', { transport });
      while (calls === 0) await new Promise(resolve => setTimeout(resolve, 0));
      const prefetch = await preloadSentenceAudio('A different sentence for later.', { transport });
      expect(prefetch).toBe(false);
      expect(calls).toBe(1);
      release?.({
        url: 'https://api.openai.com/v1/audio/speech',
        status: 200,
        headers: {},
        data: 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA'
      });
      expect((await playback).activeTier.tier).toBe(1);
    } finally {
      clearPreloadedSentenceAudio();
      vi.unstubAllGlobals();
    }
  });

  it('remembers a Gemini model-language 400 for the session and does not repeat the request', async () => {
    const config = {
      slotId: 'voice_tts' as const,
      providerId: 'gemini_tts',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelOrVoice: 'gemini-2.5-flash-preview-tts',
      customTtsVoice: 'Kore'
    };
    let calls = 0;
    let interactiveTimeoutMs = 0;
    const failingTransport = async (opts: { url: string; connectTimeout?: number }) => {
      calls++;
      interactiveTimeoutMs = opts.connectTimeout ?? 0;
      return {
        url: opts.url, status: 400, headers: {},
        data: { error: { message: 'Language sv-SE is not supported by this model.' } }
      };
    };
    await expect(synthesizeOnlineNeuralAudio('First Swedish sentence.', config, 'language-session-key', 1, failingTransport, 'sv-SE'))
      .rejects.toThrow();
    await expect(synthesizeOnlineNeuralAudio('Second Swedish sentence.', config, 'language-session-key', 1, failingTransport, 'sv-SE'))
      .rejects.toThrow();
    expect(calls).toBe(1);
    expect(interactiveTimeoutMs).toBe(15000);
  });

  it('persists prefetch audio for the active set and reuses it after simulated app restart', async () => {
    const config = {
      slotId: 'voice_tts' as const,
      providerId: 'openai_tts',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'tts-1:alloy'
    };
    await saveSlotConfig(config);
    await saveApiKey('voice_tts', 'openai_tts', 'set-persistence-key');
    await saveSlotConnectionTestResult('voice_tts', {
      ok: true, slotId: 'voice_tts', providerId: 'openai_tts', tier: 1,
      label: 'Online AI', latencyMs: 1, message: 'PASS — test fixture'
    });
    const setId = 'en:easy:ai-set-persistence';
    const generation = await activateShadowingAudioSet(setId);
    let calls = 0;
    const transport = async (opts: { url: string }) => {
      calls++;
      return { url: opts.url, status: 200, headers: {}, data: 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA' };
    };
    const sentence = 'Prefetched generated audio must survive an application restart.';
    await expect(preloadSentenceAudio(sentence, {
      transport,
      shadowingSetAudio: { setId, generation, kind: 'sentence' }
    })).resolves.toBe(true);
    expect(calls).toBe(1);

    clearMemoryAudioCache();
    resetShadowingAudioStoreForTests();
    const restoredGeneration = await activateShadowingAudioSet(setId);
    networkMonitor.setOnline(false);
    vi.stubGlobal('Audio', undefined);
    try {
      await expect(preloadSentenceAudio(sentence, {
        transport,
        shadowingSetAudio: { setId, generation: restoredGeneration, kind: 'sentence' }
      })).resolves.toBe(true);
      expect(calls).toBe(1);
      const result = await speakSentenceWithTierFallback(sentence, {
        transport,
        shadowingSetAudio: { setId, generation: restoredGeneration, kind: 'sentence' }
      });
      expect(result.fromCache).toBe(true);
      expect(result.activeTier.reason).toContain('while offline');
      expect(calls).toBe(1);
    } finally {
      networkMonitor.setOnline(true);
      vi.unstubAllGlobals();
    }
  });

  it('persists audio generated by a user Play action in the active sentence set', async () => {
    const config = {
      slotId: 'voice_tts' as const,
      providerId: 'openai_tts',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'tts-1:alloy'
    };
    await saveSlotConfig(config);
    await saveApiKey('voice_tts', 'openai_tts', 'play-persistence-key');
    await saveSlotConnectionTestResult('voice_tts', {
      ok: true, slotId: 'voice_tts', providerId: 'openai_tts', tier: 1,
      label: 'Online AI', latencyMs: 1, message: 'PASS — test fixture'
    });
    const setId = 'en:easy:play-persistence';
    const generation = await activateShadowingAudioSet(setId);
    const sentence = 'Normal model playback is also durable.';
    const key = await createAudioCacheAccountFingerprint('play-persistence-key');
    if (!key) return;
    const hash = computeAudioCacheHash({
      providerId: 'openai_tts', endpoint: config.baseUrl, accountFingerprintHash: key,
      voiceOrModel: 'tts-1:alloy||en-US', rate: 1, text: sentence
    });
    vi.stubGlobal('Audio', undefined);
    try {
      await speakSentenceWithTierFallback(sentence, {
        shadowingSetAudio: { setId, generation, kind: 'sentence' },
        transport: async opts => ({
          url: opts.url, status: 200, headers: {},
          data: 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA'
        })
      });
      await expect(readActiveShadowingAudio(hash, setId)).resolves.toContain('data:audio/');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('expires Gemini language failures and lets an explicit probe bypass the guard', async () => {
    const config = {
      slotId: 'voice_tts' as const,
      providerId: 'gemini_tts',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelOrVoice: 'gemini-2.5-flash-preview-tts',
      customTtsVoice: 'Kore'
    };
    let calls = 0;
    const transport = async (opts: { url: string }) => {
      calls++;
      return {
        url: opts.url, status: calls <= 2 ? 404 : 200, headers: {},
        data: calls <= 2
          ? { error: { message: 'Model not found' } }
          : { candidates: [{ content: { parts: [{ inlineData: { data: 'UklGRg==', mimeType: 'audio/wav' } }] } }] }
      };
    };
    vi.useFakeTimers();
    try {
      await expect(synthesizeOnlineNeuralAudio('First sentence.', config, 'gemini-language-key', 1, transport, 'en-US'))
        .rejects.toThrow();
      await expect(synthesizeOnlineNeuralAudio('Second sentence.', config, 'gemini-language-key', 1, transport, 'en-US'))
        .rejects.toThrow();
      expect(calls).toBe(1);

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      await expect(synthesizeOnlineNeuralAudio('After expiry.', config, 'gemini-language-key', 1, transport, 'en-US'))
        .rejects.toThrow();
      expect(calls).toBe(2);

      await expect(synthesizeOnlineNeuralAudio('Probe sentence.', config, 'gemini-language-key', 1, transport, 'en-US', false, undefined, true))
        .resolves.toMatchObject({ fromCache: false });
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
      clearGeminiLanguageFailures('gemini_tts');
    }
  });

  it('discards an in-flight Play result when the active sentence set changes', async () => {
    const config = {
      slotId: 'voice_tts' as const,
      providerId: 'openai_tts',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'tts-1:alloy'
    };
    await saveSlotConfig(config);
    await saveApiKey('voice_tts', 'openai_tts', 'stale-set-key');
    await saveSlotConnectionTestResult('voice_tts', {
      ok: true, slotId: 'voice_tts', providerId: 'openai_tts', tier: 1,
      label: 'Online AI', latencyMs: 1, message: 'PASS — test fixture'
    });
    const oldSetId = 'en:easy:old-stale-set';
    const oldGeneration = await activateShadowingAudioSet(oldSetId);
    const sentence = 'This generated response must not survive a set switch.';
    const fingerprint = await createAudioCacheAccountFingerprint('stale-set-key');
    if (!fingerprint) return;
    const hash = computeAudioCacheHash({
      providerId: 'openai_tts', endpoint: config.baseUrl, accountFingerprintHash: fingerprint,
      voiceOrModel: 'tts-1:alloy||en-US', rate: 1, text: sentence
    });
    let release: ((response: { url: string; status: number; headers: Record<string, string>; data: string }) => void) | undefined;
    let calls = 0;
    const transport = async () => {
      calls++;
      return new Promise<{ url: string; status: number; headers: Record<string, string>; data: string }>(resolve => { release = resolve; });
    };
    vi.stubGlobal('Audio', undefined);
    try {
      const playback = speakSentenceWithTierFallback(sentence, {
        transport,
        shadowingSetAudio: { setId: oldSetId, generation: oldGeneration, kind: 'sentence' }
      });
      while (!release) await new Promise(resolve => setTimeout(resolve, 0));
      await activateShadowingAudioSet('en:easy:new-stale-set');
      release?.({
        url: 'https://api.openai.com/v1/audio/speech', status: 200, headers: {},
        data: 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA'
      });
      await playback;
      expect(calls).toBe(1);
      await expect(readActiveShadowingAudio(hash, 'en:easy:new-stale-set')).resolves.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('requests WAV from Groq Orpheus and returns an audio/wav data URL', async () => {
    let request: any;
    const result = await synthesizeOnlineNeuralAudio('Hello from Groq.', {
      slotId: 'voice_tts',
      providerId: 'groq_tts',
      baseUrl: 'https://api.groq.com/openai/v1',
      modelOrVoice: 'canopylabs/orpheus-v1-english',
      customTtsVoice: 'troy'
    }, 'groq-test-key', 1, async (opts: any) => {
      request = opts;
      return { url: opts.url, status: 200, headers: { 'content-type': 'audio/wav' }, data: 'UklGRg==' };
    });
    expect(request.url).toBe('https://api.groq.com/openai/v1/audio/speech');
    expect(request.data).toMatchObject({ model: 'canopylabs/orpheus-v1-english', voice: 'troy', response_format: 'wav' });
    expect(request.data).not.toHaveProperty('speed');
    expect(result.dataUrl).toBe('data:audio/wav;base64,UklGRg==');
  });

  it('uses FreeTTS two-step REST file-id download without a model', async () => {
    const requests: any[] = [];
    const result = await synthesizeOnlineNeuralAudio('A FreeTTS sentence.', {
      slotId: 'voice_tts',
      providerId: 'freetts_tts',
      baseUrl: 'https://freetts.org',
      modelOrVoice: '',
      customTtsVoice: 'en-US-JennyNeural'
    }, 'freetts-test-key', 1, async (opts: any) => {
      requests.push(opts);
      if (opts.method === 'POST') {
        return { url: opts.url, status: 200, headers: { 'content-type': 'application/json' }, data: { file_id: 'test-file-id' } };
      }
      return { url: opts.url, status: 200, headers: { 'content-type': 'audio/mpeg' }, data: 'SUQzBAAAAAAA' };
    });
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe('https://freetts.org/api/v1/tts');
    expect(requests[0].headers['x-api-key']).toBe('freetts-test-key');
    expect(requests[0].data).toMatchObject({ text: 'A FreeTTS sentence.', voice: 'en-US-JennyNeural', rate: '+0%', pitch: '+0Hz' });
    expect(requests[1].url).toBe('https://freetts.org/api/audio/test-file-id');
    expect(result.dataUrl).toBe('data:audio/mpeg;base64,SUQzBAAAAAAA');
  });

  it('rejects Groq Orpheus text over its 200-character input limit', async () => {
    await expect(synthesizeOnlineNeuralAudio('x'.repeat(201), {
      slotId: 'voice_tts',
      providerId: 'groq_tts',
      baseUrl: 'https://api.groq.com/openai/v1',
      modelOrVoice: 'canopylabs/orpheus-v1-english'
    }, 'groq-test-key')).rejects.toThrow('up to 200 characters');
  });

});
