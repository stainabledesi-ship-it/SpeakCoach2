import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultSlotConfig } from '../src/config/providers';
import type { ConnectionTestResult } from '../src/config/types';
import { bootstrapApp } from '../src/main';
import { describeConnectionTestFailure, persistSlotAccountTestResult, shouldPersistSlotVerification, testSlotAccountsSequentially, testSlotConnection } from '../src/services/connectionTester';
import { synthesizeOnlineNeuralAudio } from '../src/services/ttsService';
import { networkMonitor } from '../src/services/networkMonitor';
import { getProviderAccountHealth, markProviderAccountFailure } from '../src/services/providerHealth';
import { clearAllRuntimeFailures } from '../src/services/tierManager';
import { saveApiKey } from '../src/storage/keyStore';

const validGeneratorProbe = {
  part1Questions: [
    { topic: 'Daily routines', question: 'How do you usually plan your day?' },
    { topic: 'Daily routines', question: 'What part of the day do you enjoy most?' },
    { topic: 'Daily routines', question: 'Has your daily routine changed recently?' },
    { topic: 'Public places', question: 'Which public place do you visit most?' },
    { topic: 'Public places', question: 'What makes a public place comfortable?' },
    { topic: 'Public places', question: 'Should cities create more public spaces?' }
  ],
  part2CueCard: {
    topic: 'A useful object',
    title: 'An object you use often',
    prompt: 'Describe an object you use frequently.',
    bullets: ['What it is', 'When you got it', 'How you use it', 'Why it is useful']
  },
  part3Questions: [
    { topic: 'Objects and daily life', question: 'Why do people become attached to certain objects?' },
    { topic: 'Objects and daily life', question: 'How have everyday objects changed in recent decades?' },
    { topic: 'Objects and daily life', question: 'Should products be designed to last longer?' },
    { topic: 'Objects and daily life', question: 'How does advertising influence what people buy?' }
  ]
};
import {
  loadSlotConnectionTestResult,
  loadAllSlotsConfig,
  saveSlotConfig,
  saveSlotConnectionTestResult
} from '../src/storage/localStore';

describe('Functional Deep Connection Tester', () => {
  beforeEach(() => {
    localStorage.clear();
    clearAllRuntimeFailures();
    networkMonitor.setOnline(true);
  });





  it.each([
    ['HTTP 401 unauthorized', /Key rejected.*Re-enter/i],
    ['HTTP 403 forbidden', /Key rejected.*Re-enter/i],
    ['HTTP 404 model not found', /Model or endpoint not found.*Check the model/i],
    ['HTTP 400 unsupported capability', /unsupported capability.*Check the model/i],
    ['HTTP 429 rate limit', /Quota or rate limit.*Wait for the provider/i],
    ['HTTP 503 server unavailable', /Provider server error.*Wait and retry/i],
    ['network CORS fetch failed', /Network or CORS failure.*Check the internet/i],
    ['request timed out', /Connection timed out.*wait briefly/i],
    ['unexpected internal failure', /Unclassified connection failure.*report this error/i]
  ])('classifies provider failure and suggests a next step: %s', (message, expected) => {
    const result: ConnectionTestResult = {
      ok: false, slotId: 'voice_tts', providerId: 'gemini_tts', tier: 1,
      label: 'Online AI', latencyMs: 5, message: `FAIL — ${message}`
    };
    expect(describeConnectionTestFailure(result)).toMatch(expected);
  });

  it('clears persisted account health after a successful saved connection test', async () => {
    const config = createDefaultSlotConfig('voice_tts');
    await markProviderAccountFailure('voice_tts', 'primary', Object.assign(new Error('HTTP 401 rejected'), { status: 401 }));
    expect((await getProviderAccountHealth('voice_tts', 'primary'))?.state).toBe('needs-retest');
    await persistSlotAccountTestResult(config, {
      ok: true, slotId: 'voice_tts', providerId: config.providerId, tier: 1,
      label: 'Online AI', latencyMs: 1, message: 'PASS', verificationFingerprint: 'current-test-fingerprint'
    }, 'primary');
    expect(await getProviderAccountHealth('voice_tts', 'primary')).toBeNull();
  });

  it('keeps a slot verifiable when either configured online account passes independently', () => {
    const passPrimary = { result: { ok: true, tier: 1 } as ConnectionTestResult };
    const passSecondary = { result: { ok: true, tier: 2 } as ConnectionTestResult };
    const failPrimary = { result: { ok: false, tier: 1 } as ConnectionTestResult };
    const failSecondary = { result: { ok: false, tier: 2 } as ConnectionTestResult };
    expect(shouldPersistSlotVerification([passPrimary], 1)).toBe(true);
    expect(shouldPersistSlotVerification([passPrimary, passSecondary], 2)).toBe(true);
    expect(shouldPersistSlotVerification([passPrimary, failSecondary], 2)).toBe(true);
    expect(shouldPersistSlotVerification([failPrimary, passSecondary], 2)).toBe(true);
    expect(shouldPersistSlotVerification([failPrimary, failSecondary], 2)).toBe(false);
    expect(shouldPersistSlotVerification([], 0)).toBe(false);
  });

  it('runs Test all API account probes sequentially and continues after an individual failure', async () => {
    const primary = createDefaultSlotConfig('voice_tts');
    const secondary = { ...primary, providerId: 'elevenlabs_tts', baseUrl: 'https://api.elevenlabs.io/v1', modelOrVoice: 'voice-id' };
    const order: string[] = [];
    const progress: number[] = [];
    const batch = await testSlotAccountsSequentially([
      { account: 'primary', config: primary, apiKeyOverride: 'never-return-this-key' },
      { account: 'secondary', config: secondary, apiKeyOverride: 'also-secret' }
    ], {
      pauseMs: 0,
      onProgress: current => progress.push(current),
      probe: async target => {
        order.push(target.account);
        if (target.account === 'primary') throw new Error('HTTP 401 invalid key');
        return {
          ok: true, slotId: 'voice_tts', providerId: 'elevenlabs_tts', tier: 1,
          label: 'Online AI', latencyMs: 4, message: 'PASS — secondary'
        };
      }
    });
    expect(order).toEqual(['primary', 'secondary']);
    expect(progress).toEqual([1, 2]);
    expect(batch.cancelled).toBe(false);
    expect(batch.results.map(item => item.result.ok)).toEqual([false, true]);
    expect(JSON.stringify(batch.results)).not.toContain('never-return-this-key');
    expect(JSON.stringify(batch.results)).not.toContain('also-secret');
  });

  it('cancels sequential API testing between probes without starting the next account', async () => {
    const config = createDefaultSlotConfig('voice_tts');
    let calls = 0;
    let cancel = false;
    const batch = await testSlotAccountsSequentially([
      { account: 'primary', config },
      { account: 'secondary', config: { ...config, providerId: 'elevenlabs_tts' } }
    ], {
      pauseMs: 0,
      shouldCancel: () => cancel,
      probe: async () => {
        calls += 1;
        cancel = true;
        return {
          ok: true, slotId: 'voice_tts', providerId: 'openai_tts', tier: 1,
          label: 'Online AI', latencyMs: 2, message: 'PASS'
        };
      }
    });
    expect(calls).toBe(1);
    expect(batch.cancelled).toBe(true);
    expect(batch.results).toHaveLength(1);
  });


  it('re-applies failed secondary provider health after persisting the failed single-test result', async () => {
    const config = {
      slotId: 'voice_tts' as const, providerId: 'elevenlabs_tts',
      baseUrl: 'https://api.elevenlabs.io/v1', modelOrVoice: 'voice-id'
    };
    await persistSlotAccountTestResult(config, {
      ok: false, slotId: 'voice_tts', providerId: 'elevenlabs_tts', tier: 1,
      label: 'Online AI', latencyMs: 8, message: 'FAIL — HTTP 401 invalid API key'
    }, 'secondary');
    await expect(getProviderAccountHealth('voice_tts', 'secondary')).resolves.toMatchObject({ state: 'needs-retest', status: 401 });
  });

  it('persists primary connection results through the shared account test path', async () => {
    const config = createDefaultSlotConfig('voice_tts');
    config.providerId = 'openai_tts';
    config.baseUrl = 'https://api.openai.com/v1';
    config.modelOrVoice = 'tts-1:alloy';
    await saveSlotConfig(config);
    const result: ConnectionTestResult = {
      ok: true, slotId: 'voice_tts', providerId: 'openai_tts', tier: 1,
      label: 'Online AI', latencyMs: 12, message: 'PASS — shared test', verificationFingerprint: 'primary-fingerprint'
    };
    const persisted = await persistSlotAccountTestResult(config, result, 'primary');
    expect(persisted?.timestamp).toBeGreaterThan(0);
    await expect(loadSlotConnectionTestResult('voice_tts')).resolves.toMatchObject({ ok: true, providerId: 'openai_tts', verificationFingerprint: 'primary-fingerprint' });
  });

  it('persists secondary verification snapshots through the same shared path', async () => {
    const config = {
      slotId: 'voice_tts' as const, providerId: 'elevenlabs_tts',
      baseUrl: 'https://api.elevenlabs.io/v1', modelOrVoice: 'voice-id'
    };
    const result: ConnectionTestResult = {
      ok: true, slotId: 'voice_tts', providerId: 'elevenlabs_tts', tier: 1,
      label: 'Online AI', latencyMs: 18, message: 'PASS — shared secondary test', verificationFingerprint: 'secondary-fingerprint'
    };
    await persistSlotAccountTestResult(config, result, 'secondary');
    const stored = (await loadAllSlotsConfig()).voice_tts.secondary;
    expect(stored?.verified).toBe(true);
    expect(stored?.testResult).toMatchObject({ ok: true, message: 'PASS — shared secondary test', verificationFingerprint: 'secondary-fingerprint' });
  });

  it('passes immediately for Tier 3 offline providers without needing a key or internet', async () => {
    const res = await testSlotConnection(
      {
        slotId: 'voice_tts',
        providerId: 'android_native_tts',
        baseUrl: 'offline://android-tts',
        modelOrVoice: 'en-US'
      },
      { isOnlineOverride: false }
    );
    expect(res.ok).toBe(true);
    expect(res.tier).toBe(3);
    expect(res.label).toBe('Basic offline');
    expect(res.message).toContain('PASS');
  });

  it('fails with clear message when online provider has no API key', async () => {
    const cfg = createDefaultSlotConfig('llm_evaluator');
    const res = await testSlotConnection(cfg, { apiKeyOverride: '' });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('API key is empty');
    expect(res.message).toContain('Step: API Key Validation');
  });

  it('deep tests LLM Generator by requesting JSON and validating response shape', async () => {
    const genCfg = {
      slotId: 'llm_generator' as const,
      providerId: 'openai_compat_gen',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'gpt-4o-mini'
    };

    // 1. Successful JSON response
    const passRes = await testSlotConnection(genCfg, {
      apiKeyOverride: 'sk-gen-key',
      transport: async (opts) => {
        expect(opts.url).toBe('https://api.openai.com/v1/chat/completions');
        const request = opts.data as { messages: Array<{ content: string }>; response_format: { type: string } };
        expect(request.messages[0].content).toContain('Create a compact but valid IELTS Speaking test plan');
        expect(request.messages[0].content).toContain('part1Questions');
        expect(request.messages[0].content).toContain('part2CueCard');
        expect(request.messages[0].content).toContain('part3Questions');
        expect(request.messages[0].content).not.toContain('"status":"ok"');
        expect(request.response_format).toEqual({ type: 'json_object' });
        return {
          url: opts.url,
          status: 200,
          headers: {},
          data: {
            choices: [{ message: { content: JSON.stringify(validGeneratorProbe) } }]
          }
        };
      }
    });
    expect(passRes.ok).toBe(true);
    expect(passRes.message).toMatch(/^PASS — .+ test passed \(capability probe, /);

    // Gemini must receive the same IELTS plan probe, with only its transport envelope differing.
    const geminiRes = await testSlotConnection({
      slotId: 'llm_generator',
      providerId: 'gemini_gen',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelOrVoice: 'gemini-2.5-flash'
    }, {
      apiKeyOverride: 'gemini-gen-key',
      transport: async opts => {
        expect(opts.url).toContain('gemini-2.5-flash:generateContent');
        const request = opts.data as { contents: Array<{ parts: Array<{ text: string }> }>; generationConfig: Record<string, unknown> };
        const prompt = request.contents[0].parts[0].text;
        expect(prompt).toContain('Create a compact but valid IELTS Speaking test plan');
        expect(prompt).toContain('part1Questions');
        expect(prompt).toContain('part2CueCard');
        expect(prompt).toContain('part3Questions');
        expect(request.generationConfig.responseMimeType).toBe('application/json');
        return {
          url: opts.url, status: 200, headers: {},
          data: { candidates: [{ content: { parts: [{ text: JSON.stringify(validGeneratorProbe) }] } }] }
        };
      }
    });
    expect(geminiRes.ok).toBe(true);

    // 2. Invalid shape failure
    const badShapeRes = await testSlotConnection(genCfg, {
      apiKeyOverride: 'sk-gen-key',
      transport: async (opts) => ({
        url: opts.url,
        status: 200,
        headers: {},
        data: {
          choices: [{ message: { content: 'This is plain text without json' } }]
        }
      })
    });
    expect(badShapeRes.ok).toBe(false);
    expect(badShapeRes.message).toContain('Step: JSON Response Shape Validation');

    // 3. HTTP 401 failure
    const authFailRes = await testSlotConnection(genCfg, {
      apiKeyOverride: 'sk-bad-key',
      transport: async (opts) => ({
        url: opts.url,
        status: 401,
        headers: {},
        data: { error: { message: 'Invalid API key' } }
      })
    });
    expect(authFailRes.ok).toBe(false);
    expect(authFailRes.message).toContain('Step: HTTP Request (HTTP 401)');
  });

  it('lightly tests the Evaluator API without generating a full IELTS feedback report', async () => {
    const evalCfg = {
      slotId: 'llm_evaluator' as const,
      providerId: 'gemini_eval',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelOrVoice: 'gemini-2.5-flash'
    };

    // 1. Successful schema response
    const validPayload = {
      fluencyCoherenceBand: 6.5,
      lexicalResourceBand: 7.0,
      grammaticalRangeBand: 6.0
    };

    const passRes = await testSlotConnection(evalCfg, {
      apiKeyOverride: 'gemini-test-key',
      transport: async (opts) => {
        expect(opts.url).toContain('gemini-2.5-flash:generateContent');
        const request = opts.data as { contents: Array<{ parts: Array<{ text: string }> }>; generationConfig: Record<string, unknown> };
        const prompt = request.contents[0].parts[0].text;
        expect(prompt.length).toBeLessThan(500);
        expect(prompt).toContain('short API connection test');
        expect(prompt).not.toContain('topPriorities');
        expect(opts.connectTimeout).toBe(45000);
        expect(opts.readTimeout).toBe(45000);
        return {
          url: opts.url,
          status: 200,
          headers: {},
          data: {
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify(validPayload) }]
                }
              }
            ]
          }
        };
      }
    });
    expect(passRes.ok).toBe(true);
    expect(passRes.message).toMatch(/^PASS — .+ test passed \(/);

    // 2. Missing required schema field
    const invalidPayload = {
      fluencyCoherenceBand: 6.5
      // missing lexicalResourceBand and grammaticalRangeBand
    };
    const schemaFailRes = await testSlotConnection(evalCfg, {
      apiKeyOverride: 'gemini-test-key',
      transport: async (opts) => ({
        url: opts.url,
        status: 200,
        headers: {},
        data: {
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify(invalidPayload) }]
              }
            }
          ]
        }
      })
    });
    expect(schemaFailRes.ok).toBe(false);
    expect(schemaFailRes.message).toContain('Step: JSON Schema Validation');
    expect(schemaFailRes.message).toContain('missing numeric band scores');

    // 3. HTTP 429 is reported as a provider limit, not as an offline fallback.
    const rateLimitRes = await testSlotConnection(evalCfg, {
      apiKeyOverride: 'gemini-test-key',
      transport: async (opts) => ({
        url: opts.url,
        status: 429,
        headers: {},
        data: { error: { message: 'Quota exceeded' } }
      })
    });
    expect(rateLimitRes.ok).toBe(false);
    expect(rateLimitRes.message).toContain('HTTP 429');
    expect(rateLimitRes.message).toContain('no offline evaluator is available');
    expect(rateLimitRes.message).not.toContain('Auto-fallback to Basic offline is ready');
  });

  it('does not report the disabled IELTS offline evaluator as ready', async () => {
    const res = await testSlotConnection({
      slotId: 'llm_evaluator',
      providerId: 'offline_rule_eval',
      baseUrl: 'offline://rule-evaluator',
      modelOrVoice: 'heuristic-v1'
    }, { isOnlineOverride: false });

    expect(res.ok).toBe(false);
    expect(res.message).toContain('IELTS evaluation requires an online AI API');
    expect(res.message).toContain('Offline IELTS evaluation is not available');
  });

  it('deep tests the independent Translation API slot with a plain-text translation probe', async () => {
    const translationCfg = createDefaultSlotConfig('llm_translation');
    const result = await testSlotConnection(translationCfg, {
      apiKeyOverride: 'translation-key',
      transport: async opts => {
        expect(opts.url).toBe('https://api.openai.com/v1/chat/completions');
        const request = opts.data as { messages: Array<{ content: string }>; model: string };
        expect(request.messages[0].content).toContain('precise translator');
        expect(request.messages[1].content).toContain('Translate the English word');
        return { url: opts.url, status: 200, headers: {}, data: { choices: [{ message: { content: 'سلام' } }] } };
      }
    });
    expect(result.ok).toBe(true);
    expect(result.slotId).toBe('llm_translation');
    expect(result.message).toContain('capability probe');
  });

  it('does not report offline translation as ready', async () => {
    const result = await testSlotConnection({ slotId: 'llm_translation', providerId: 'offline_translation', baseUrl: 'offline://translation-unavailable', modelOrVoice: 'none' }, { isOnlineOverride: false });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('No offline translation engine is available');
  });

  it('deep tests STT slot with bundled WAV and validates transcription response', async () => {
    const sttCfg = {
      slotId: 'ielts_stt' as const,
      providerId: 'whisper_stt',
      baseUrl: 'https://api.groq.com/openai/v1',
      modelOrVoice: 'whisper-large-v3-turbo'
    };

    // 1. Success response
    const passRes = await testSlotConnection(sttCfg, {
      apiKeyOverride: 'groq-key',
      transport: async (opts) => {
        expect(opts.url).toContain('/audio/transcriptions');
        expect(opts.dataType).toBe('formData');
        expect(Array.isArray(opts.data)).toBe(true);
        expect((opts.data as Array<Record<string, string>>).some((entry) => entry.type === 'base64File' && entry.key === 'file' && entry.fileName === 'sample.wav')).toBe(true);
        return {
          url: opts.url,
          status: 200,
          headers: {},
          data: {
            text: 'Hello SpeakCoach test',
            words: [{ word: 'Hello', start: 0.1, end: 0.5 }]
          }
        };
      }
    });
    expect(passRes.ok).toBe(true);
    expect(passRes.message).toContain('transcription endpoint accepted the probe audio');

    // 2. HTTP 429 rate limit failure
    const rateLimitRes = await testSlotConnection(sttCfg, {
      apiKeyOverride: 'groq-key',
      transport: async (opts) => ({
        url: opts.url,
        status: 429,
        headers: {},
        data: { error: { message: 'Rate limit exceeded' } }
      })
    });
    expect(rateLimitRes.ok).toBe(false);
    expect(rateLimitRes.message).toContain('Step: HTTP Request (HTTP 429)');
  });

  it('keeps Gemini STT connection testing compatible with the previously working main-branch probe', async () => {
    const result = await testSlotConnection({
      slotId: 'ielts_stt',
      providerId: 'gemini_stt',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelOrVoice: 'gemini-2.5-flash'
    }, {
      apiKeyOverride: 'gemini-stt-key',
      transport: async opts => {
        const payload = opts.data as Record<string, any>;
        expect(payload.contents[0].parts[0].text).toBe('Transcribe the attached audio exactly as spoken.');
        expect(payload.generationConfig.audioTranscriptionConfig).toEqual({ mode: 'VERBATIM' });
        return {
          url: opts.url, status: 200, headers: {},
          // Match the original main-branch contract: the synthetic probe only
          // verifies that Gemini accepted the request and returned a candidate.
          data: { candidates: [{ content: {} }] }
        };
      }
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('transcription endpoint accepted the probe audio');
  });

  it('fails Gemini STT connection test when the API returns no candidates', async () => {
    const result = await testSlotConnection({
      slotId: 'ielts_stt',
      providerId: 'gemini_stt',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelOrVoice: 'gemini-2.5-flash'
    }, {
      apiKeyOverride: 'gemini-stt-key',
      transport: async opts => ({
        url: opts.url, status: 200, headers: {},
        data: { candidates: [] }
      })
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Gemini STT response did not contain candidates');
  });

  it('tests Azure Pronunciation Assessment through the actual short-audio assessment endpoint', async () => {
    const result = await testSlotConnection({
      slotId: 'pronunciation_scoring',
      providerId: 'azure_pronunciation',
      baseUrl: 'https://eastus.stt.speech.microsoft.com',
      modelOrVoice: 'en-US'
    }, {
      apiKeyOverride: 'azure-speech-key',
      transport: async opts => {
        expect(opts.url).toContain('/speech/recognition/conversation/cognitiveservices/v1');
        expect(opts.url).toContain('format=detailed');
        expect(opts.url).toContain('language=en-US');
        expect(opts.method).toBe('POST');
        expect(opts.dataType).toBe('file');
        expect(opts.headers?.['Ocp-Apim-Subscription-Key']).toBe('azure-speech-key');
        expect(opts.headers?.['Pronunciation-Assessment']).toBeTruthy();
        expect(opts.headers?.['Content-Type']).toContain('audio/wav');
        expect(typeof opts.data).toBe('string');
        return {
          url: opts.url, status: 200, headers: {},
          data: { RecognitionStatus: 'NoMatch' }
        };
      }
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('pronunciation-assessment endpoint accepted the WAV probe');
  });

  it('deep tests Whisper Alignment with the actual transcription endpoint, not only a model-list endpoint', async () => {
    const cfg = {
      slotId: 'pronunciation_scoring' as const,
      providerId: 'whisper_alignment',
      baseUrl: 'https://api.groq.com/openai/v1',
      modelOrVoice: 'whisper-large-v3-turbo'
    };
    const result = await testSlotConnection(cfg, {
      apiKeyOverride: 'groq-pronunciation-key',
      transport: async opts => {
        expect(opts.url).toContain('/audio/transcriptions');
        expect(opts.method).toBe('POST');
        expect(opts.dataType).toBe('formData');
        expect(Array.isArray(opts.data)).toBe(true);
        return {
          url: opts.url,
          status: 200,
          headers: {},
          data: { text: '', words: [] }
        };
      }
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('transcription endpoint accepted the probe audio');
  });

  it('deep tests TTS slot and validates playable audio data URL output', async () => {
    const ttsCfg = {
      slotId: 'voice_tts' as const,
      providerId: 'openai_tts',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'tts-1:alloy'
    };

    // 1. Valid audio binary response
    const passRes = await testSlotConnection(ttsCfg, {
      apiKeyOverride: 'sk-tts-key',
      transport: async (opts) => {
        expect(opts.url).toContain('/audio/speech');
        return {
          url: opts.url,
          status: 200,
          headers: {},
          data: 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA' // valid mp3 base64 prefix
        };
      }
    });
    expect(passRes.ok).toBe(true);
    expect(passRes.message).toMatch(/^PASS — .+ test passed \(/);

    // 2. Empty audio payload
    const emptyRes = await testSlotConnection(ttsCfg, {
      apiKeyOverride: 'sk-tts-key',
      transport: async (opts) => ({
        url: opts.url,
        status: 200,
        headers: {},
        data: ''
      })
    });
    expect(emptyRes.ok).toBe(false);
    expect(emptyRes.message).toContain('Step: Audio Synthesis Validation');
  });

  it('renders all 6 configurable provider slots in SettingsView with Deep test button', async () => {
    const root = document.createElement('div');
    await bootstrapApp(root, 'settings');

    const slotCards = root.querySelectorAll('[data-slot-card]');
    expect(slotCards).toHaveLength(6);

    const testButtons = root.querySelectorAll('[data-test-slot]');
    expect(testButtons).toHaveLength(6);
    expect(testButtons[0].textContent).toContain('Test API 1');
  });

  it('persists the last connection-test result and timestamp per slot across app restarts', async () => {
    const testResult: ConnectionTestResult = {
      ok: true,
      slotId: 'llm_evaluator',
      providerId: 'openai_compat_eval',
      tier: 1,
      label: 'Online AI',
      latencyMs: 142,
      message: 'PASS — OpenAI (Tier 1) test passed (142 ms).'
    };

    await saveApiKey('llm_evaluator', 'openai_compat_eval', 'persist-test-key');
    await saveSlotConnectionTestResult('llm_evaluator', testResult);

    const loaded = await loadSlotConnectionTestResult('llm_evaluator');
    expect(loaded).not.toBeNull();
    expect(loaded?.ok).toBe(true);
    expect(loaded?.slotId).toBe('llm_evaluator');
    expect(loaded?.latencyMs).toBe(142);
    expect(typeof loaded?.timestamp).toBe('number');
    expect(loaded?.timestamp).toBeGreaterThan(0);

    const root = document.createElement('div');
    await bootstrapApp(root, 'settings');

    const statusEl = root.querySelector('#status-llm_evaluator');
    expect(statusEl?.textContent).toContain('PASS — OpenAI (Tier 1) test passed');
    expect(statusEl?.textContent).toContain('Tested:');
  });
  it('Gemini TTS connection test bypasses a previously cached probe and makes a live request', async () => {
    const config = {
      slotId: 'voice_tts' as const,
      providerId: 'gemini_tts',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelOrVoice: 'gemini-3.8-flash-lite-tts',
      customTtsVoice: 'Puck'
    };
    const apiKey = 'cache-bypass-regression-key';
    const wav = Buffer.from('RIFF' + 'p'.repeat(48)).toString('base64');

    await synthesizeOnlineNeuralAudio('Hello from SpeakCoach.', config, apiKey, 1, async opts => ({
      url: opts.url, status: 200, headers: {},
      data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav } }] } }] }
    }));

    let liveRequests = 0;
    let connectionTimeoutMs = 0;
    const result = await testSlotConnection(config, {
      apiKeyOverride: apiKey,
      isOnlineOverride: true,
      transport: async opts => {
        liveRequests++;
        connectionTimeoutMs = opts.connectTimeout ?? 0;
        return {
          url: opts.url, status: 401, headers: {},
          data: { error: { message: 'API key revoked' } }
        };
      }
    });

    expect(liveRequests).toBe(1);
    expect(connectionTimeoutMs).toBe(45000);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('HTTP 401');
  });


  it('tests Groq TTS through the same WAV request used by playback', async () => {
    const result = await testSlotConnection({
      slotId: 'voice_tts', providerId: 'groq_tts',
      baseUrl: 'https://api.groq.com/openai/v1',
      modelOrVoice: 'canopylabs/orpheus-v1-english',
      customTtsVoice: 'hannah'
    }, {
      apiKeyOverride: 'groq-tts-key',
      transport: async opts => {
        expect(opts.url).toBe('https://api.groq.com/openai/v1/audio/speech');
        expect(opts.headers?.Authorization).toBe('Bearer groq-tts-key');
        expect(opts.data).toMatchObject({
          model: 'canopylabs/orpheus-v1-english',
          voice: 'hannah', input: 'Hello from SpeakCoach.', response_format: 'wav'
        });
        return { url: opts.url, status: 200, headers: {}, data: 'UklGRiQAAABX' };
      }
    });
    expect(result.ok).toBe(true);
  });

  it('tests FreeTTS through its create-and-download API flow', async () => {
    let calls = 0;
    const result = await testSlotConnection({
      slotId: 'voice_tts', providerId: 'freetts_tts',
      baseUrl: 'https://freetts.org',
      modelOrVoice: '',
      customTtsVoice: 'en-US-JennyNeural'
    }, {
      apiKeyOverride: 'free-tts-key',
      transport: async opts => {
        calls++;
        if (calls === 1) {
          expect(opts.url).toBe('https://freetts.org/api/v1/tts');
          expect(opts.headers?.['x-api-key']).toBe('free-tts-key');
          expect(opts.data).toMatchObject({ text: 'Hello from SpeakCoach.', voice: 'en-US-JennyNeural', output_format: 'mp3' });
          return { url: opts.url, status: 200, headers: {}, data: { file_id: 'file-123' } };
        }
        expect(opts.url).toBe('https://freetts.org/api/audio/file-123');
        expect(opts.method).toBe('GET');
        return { url: opts.url, status: 200, headers: {}, data: 'SUQzBAAAAAAA' };
      }
    });
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
  });

});