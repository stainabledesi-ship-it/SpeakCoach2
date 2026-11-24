import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllProviderAccountHealth, createProviderVerificationFingerprint, markProviderAccountFailure } from '../src/services/providerHealth';
import { createDefaultSlotConfig, getPreset } from '../src/config/providers';
import { nativeHttpRequest, SpeakCoachHttpError } from '../src/services/httpClient';
import { networkMonitor } from '../src/services/networkMonitor';
import {
  clearAllRuntimeFailures,
  executeWithTierFallback,
  isOnlineIeltsSttTier,
  markSlotRuntimeFailure,
  resolveGlobalTierSummary,
  resolveSlotTier,
  RUNTIME_FAILURE_TTL_MS
} from '../src/services/tierManager';
import { testSlotConnection } from '../src/services/connectionTester';
import { saveApiKey } from '../src/storage/keyStore';
import { loadAllSlotsConfig, saveSecondarySlotConfig, saveSlotConfig, saveSlotConnectionTestResult } from '../src/storage/localStore';

async function markSlotVerified(slotId: 'voice_tts' | 'llm_evaluator' | 'llm_generator', providerId: string, tier: 1 | 2 = 1): Promise<void> {
  const current = await loadAllSlotsConfig();
  if (current[slotId].providerId !== providerId) {
    const preset = getPreset(slotId, providerId);
    await saveSlotConfig({
      ...createDefaultSlotConfig(slotId),
      providerId,
      baseUrl: preset.defaultBaseUrl,
      modelOrVoice: preset.defaultModelOrVoice
    });
  }
  await saveSlotConnectionTestResult(slotId, {
    ok: true,
    slotId,
    providerId,
    tier,
    label: 'Online AI',
    latencyMs: 1,
    message: 'PASS — test verification'
  });
}

describe('HTTP Client & 3-Tier Auto-Fallback Framework', () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearAllProviderAccountHealth();
    clearAllRuntimeFailures();
    networkMonitor.setOnline(true);
  });

  it('defaults to "Basic offline" (Tier 3) when no API keys are configured', async () => {
    const summary = await resolveGlobalTierSummary();
    expect(summary.label).toBe('Basic offline');
    expect(summary.onlineSlotsCount).toBe(0);
    expect(summary.slots.voice_tts.tier).toBe(3);
    expect(summary.slots.voice_tts.isFallback).toBe(true);
    expect(summary.slots.voice_tts.reason).toBe('No API key configured');
  });

  it('upgrades to "Online AI" when a valid key is saved and network is online', async () => {
    await saveApiKey('voice_tts', 'openai_tts', 'sk-live-key');
    const slotConfig = createDefaultSlotConfig('voice_tts');
    await markSlotVerified('voice_tts', 'openai_tts');

    const resolved = await resolveSlotTier(slotConfig, { isOnline: true });
    expect(resolved.tier).toBe(1);
    expect(resolved.label).toBe('Online AI');
    expect(resolved.isFallback).toBe(false);

    const summary = await resolveGlobalTierSummary();
    expect(summary.label).toBe('Online AI');
    expect(summary.onlineSlotsCount).toBe(1);
  });

  it('does not show a configured provider as online until Save and a successful test', async () => {
    const slotConfig = {
      slotId: 'llm_evaluator' as const,
      providerId: 'openai_compat_eval',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'gpt-4o-mini'
    };
    await saveSlotConfig(slotConfig);
    await saveApiKey('llm_evaluator', 'openai_compat_eval', 'sk-test-key');

    const beforeTest = await resolveSlotTier(slotConfig, { isOnline: true });
    expect(beforeTest.tier).toBe(3);
    expect(beforeTest.reason).toContain('successful test');
    expect(beforeTest.reason).toContain('Test API 1');
    expect(beforeTest.reason).toContain('LLM Evaluator');

    await markSlotVerified('llm_evaluator', 'openai_compat_eval');
    const afterTest = await resolveSlotTier(slotConfig, { isOnline: true });
    expect(afterTest.tier).toBe(1);
    expect(afterTest.label).toBe('Online AI');
  });

  it('automatically falls back to "Basic offline" in Airplane mode even with API keys saved', async () => {
    await saveApiKey('voice_tts', 'openai_tts', 'sk-live-key');
    await saveApiKey('llm_evaluator', 'openai_compat_eval', 'sk-eval-key');

    networkMonitor.setOnline(false);

    const summary = await resolveGlobalTierSummary();
    expect(summary.label).toBe('Basic offline');
    expect(summary.onlineSlotsCount).toBe(0);
    expect(summary.slots.voice_tts.tier).toBe(3);
    expect(summary.slots.voice_tts.label).toBe('Basic offline');
    expect(summary.slots.voice_tts.reason).toBe('No internet connection');
  });

  it('executes offline fallback automatically if an online provider throws at runtime', async () => {
    await saveApiKey('llm_generator', 'openai_compat_gen', 'sk-gen-key');
    await markSlotVerified('llm_generator', 'openai_compat_gen');

    const outcome = await executeWithTierFallback(
      'llm_generator',
      async () => {
        throw new Error('HTTP 503 Service Unavailable');
      },
      async () => {
        return ['Offline fallback sentence 1'];
      }
    );

    expect(outcome.result).toEqual(['Offline fallback sentence 1']);
    expect(outcome.activeTier.tier).toBe(3);
    expect(outcome.activeTier.label).toBe('Basic offline');
    expect(outcome.activeTier.isFallback).toBe(true);
  });

  it('retries transient HTTP 503 errors and translates 401 errors into human-readable messages', async () => {
    let calls = 0;
    const okRes = await nativeHttpRequest<{ ok: boolean }>(
      {
        url: 'https://api.example.com/v1/models',
        maxRetries: 1,
        retryDelayMs: 5
      },
      async (opts) => {
        calls++;
        if (calls === 1) {
          return {
            url: opts.url,
            status: 503,
            headers: {},
            data: { message: 'Temporary overload' }
          };
        }
        return {
          url: opts.url,
          status: 200,
          headers: {},
          data: { ok: true }
        };
      }
    );

    expect(calls).toBe(2);
    expect(okRes.data.ok).toBe(true);

    await expect(
      nativeHttpRequest(
        {
          url: 'https://api.example.com/v1/models',
          maxRetries: 0
        },
        async (opts) => ({
          url: opts.url,
          status: 401,
          headers: {},
          data: { error: { message: 'Invalid API key' } }
        })
      )
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SpeakCoachHttpError);
      const httpErr = err as SpeakCoachHttpError;
      expect(httpErr.status).toBe(401);
      expect(httpErr.humanMessage).toContain('Authentication failed (HTTP 401)');
      return true;
    });
  });

  it('after app restart a saved slot is online', async () => {
    // Save configuration with key, baseUrl, and model
    await saveSlotConfig({
      slotId: 'llm_evaluator',
      providerId: 'openai_compat_eval',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'gpt-4o-mini'
    });
    await saveApiKey('llm_evaluator', 'openai_compat_eval', 'sk-test-live-key');
    await markSlotVerified('llm_evaluator', 'openai_compat_eval');

    // Simulate app restart: fresh in-memory state, online network, load from storage
    clearAllRuntimeFailures();
    networkMonitor.setOnline(true);

    const summary = await resolveGlobalTierSummary();
    const evaluatorSlot = summary.slots.llm_evaluator;

    expect(evaluatorSlot.tier).toBe(1);
    expect(evaluatorSlot.label).toBe('Online AI');
    expect(evaluatorSlot.isFallback).toBe(false);
    expect(evaluatorSlot.reason).toBeUndefined();

    // Verify evaluation-time decision also uses tierManager to select online action
    let executedOnline = false;
    const outcome = await executeWithTierFallback(
      'llm_evaluator',
      async (tier) => {
        executedOnline = true;
        return { evaluation: 'online result', tier: tier.tier };
      },
      async () => {
        return { evaluation: 'offline result', tier: 3 };
      }
    );

    expect(executedOnline).toBe(true);
    expect(outcome.result.evaluation).toBe('online result');
    expect(outcome.activeTier.tier).toBe(1);
    expect(outcome.activeTier.label).toBe('Online AI');
  });

  it('falls back to "Basic offline" when baseUrl or model is missing even if key is present', async () => {
    await saveApiKey('voice_tts', 'openai_tts', 'sk-valid-key');

    // Missing baseUrl
    const noBaseUrlCfg = {
      ...createDefaultSlotConfig('voice_tts'),
      baseUrl: ''
    };
    const resolvedNoBaseUrl = await resolveSlotTier(noBaseUrlCfg, { isOnline: true });
    expect(resolvedNoBaseUrl.tier).toBe(3);
    expect(resolvedNoBaseUrl.label).toBe('Basic offline');
    expect(resolvedNoBaseUrl.reason).toBe('No base URL configured');

    // Missing model
    const noModelCfg = {
      ...createDefaultSlotConfig('voice_tts'),
      modelOrVoice: '   '
    };
    const resolvedNoModel = await resolveSlotTier(noModelCfg, { isOnline: true });
    expect(resolvedNoModel.tier).toBe(3);
    expect(resolvedNoModel.label).toBe('Basic offline');
    expect(resolvedNoModel.reason).toBe('No model configured');
  });

  it('only treats 401/403 as sticky, expires sticky failures after TTL or on config save, and never forces Tier 3 from failed tests (A1-5, A2-5)', async () => {
    const evalCfg = {
      slotId: 'llm_evaluator' as const,
      providerId: 'openai_compat_eval',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'gpt-4o-mini'
    };
    await saveSlotConfig(evalCfg);
    await saveApiKey('llm_evaluator', 'openai_compat_eval', 'sk-test-key');
    await markSlotVerified('llm_evaluator', 'openai_compat_eval');

    // 1. Transient errors (429, 503, timeout) in executeWithTierFallback fall back for that call ONLY and are NOT sticky
    const transientOutcome = await executeWithTierFallback(
      'llm_evaluator',
      async () => {
        throw new SpeakCoachHttpError({
          status: 429,
          message: 'Rate limit',
          humanMessage: 'Rate limit exceeded (HTTP 429)'
        });
      },
      async () => 'offline-once'
    );
    expect(transientOutcome.result).toBe('offline-once');
    expect(transientOutcome.activeTier.tier).toBe(3);

    // Immediately after transient 429, slot is still Online AI (Tier 1)
    const after429 = await resolveSlotTier(evalCfg);
    expect(after429.tier).toBe(1);
    expect(after429.label).toBe('Online AI');

    // Direct markSlotRuntimeFailure with non-auth reason (e.g. 503/timeout) does not stick
    markSlotRuntimeFailure('llm_evaluator', 'Request timed out after 15000ms');
    expect((await resolveSlotTier(evalCfg)).tier).toBe(1);

    // 2. Auth errors (401 / 403) ARE sticky initially
    const t0 = Date.now();
    markSlotRuntimeFailure('llm_evaluator', 'Authentication failed (HTTP 401)', {
      status: 401,
      at: t0
    });
    const duringSticky = await resolveSlotTier(evalCfg, { nowMs: t0 + 30_000 });
    expect(duringSticky.tier).toBe(3);
    expect(duringSticky.reason).toContain('401');

    // 3. Sticky 401/403 expires automatically after RUNTIME_FAILURE_TTL_MS (a few minutes)
    const afterExpiry = await resolveSlotTier(evalCfg, {
      nowMs: t0 + RUNTIME_FAILURE_TTL_MS + 1000
    });
    expect(afterExpiry.tier).toBe(1);
    expect(afterExpiry.label).toBe('Online AI');

    // 4. Sticky 403 is cleared immediately when saving slot config
    markSlotRuntimeFailure('llm_evaluator', 'Forbidden (HTTP 403)', { status: 403 });
    expect((await resolveSlotTier(evalCfg)).tier).toBe(3);

    await saveSlotConfig(evalCfg);
    expect((await resolveSlotTier(evalCfg)).tier).toBe(3);
    await markSlotVerified('llm_evaluator', 'openai_compat_eval');
    expect((await resolveSlotTier(evalCfg)).tier).toBe(1);

    // 5. Failed test (even with 401/503/timeout) must NOT force the slot into Tier 3
    const failedDeepTest = await testSlotConnection(evalCfg, {
      apiKeyOverride: 'sk-test-key',
      transport: async (opts) => ({
        url: opts.url,
        status: 503,
        headers: {},
        data: { error: { message: 'Temporary overload' } }
      })
    });
    expect(failedDeepTest.ok).toBe(false);
    await saveSlotConnectionTestResult('llm_evaluator', failedDeepTest);
    const afterDeepTest = await resolveSlotTier(evalCfg);
    expect(afterDeepTest.tier).toBe(1);
    expect(afterDeepTest.label).toBe('Online AI');
  });
});


describe('IELTS STT online tier detection', () => {
  it('treats Tier 1 and Tier 2 as online and Tier 3 as offline', () => {
    expect(isOnlineIeltsSttTier(1, 'Online AI')).toBe(true);
    expect(isOnlineIeltsSttTier(2, 'Online AI')).toBe(true);
    expect(isOnlineIeltsSttTier(3, 'Basic offline')).toBe(false);
    expect(isOnlineIeltsSttTier(1, 'Basic offline')).toBe(false);
  });
  it('invalidates a saved PASS when the API key or model configuration changes', async () => {
    const config = {
      slotId: 'voice_tts' as const,
      providerId: 'openai_tts',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'tts-1:alloy'
    };
    await saveSlotConfig(config);
    await saveApiKey('voice_tts', 'openai_tts', 'fingerprint-key-one');
    await markSlotVerified('voice_tts', 'openai_tts');

    expect((await resolveSlotTier(config, { isOnline: true })).tier).toBe(1);

    await saveApiKey('voice_tts', 'openai_tts', 'fingerprint-key-two');
    const keyChanged = await resolveSlotTier(config, { isOnline: true });
    expect(keyChanged.tier).toBe(3);
    expect(keyChanged.reason).toMatch(/verification expired or no longer matches/i);

    await saveApiKey('voice_tts', 'openai_tts', 'fingerprint-key-one');
    const changedModel = { ...config, modelOrVoice: 'tts-1:nova' };
    const modelChanged = await resolveSlotTier(changedModel, { isOnline: true });
    expect(modelChanged.tier).toBe(3);
    expect(modelChanged.reason).toMatch(/verification expired or no longer matches/i);
  });

  it('keeps the slot online through the healthy alternate account when either API fails', async () => {
    for (const failedAccount of ['primary', 'secondary'] as const) {
      localStorage.clear();
      await clearAllProviderAccountHealth();
      clearAllRuntimeFailures();

      const primary = {
        ...createDefaultSlotConfig('voice_tts'),
        providerId: 'openai_tts',
        baseUrl: 'https://api.openai.com/v1',
        modelOrVoice: 'tts-1:alloy',
        secondary: {
          providerId: 'elevenlabs_tts',
          baseUrl: 'https://api.elevenlabs.io/v1',
          modelOrVoice: 'voice-id',
          verified: false
        }
      };
      const primaryKey = 'primary-independent-key';
      const secondaryKey = 'secondary-independent-key';
      await saveSlotConfig(primary);
      await saveApiKey('voice_tts', 'openai_tts', primaryKey);
      await saveApiKey('voice_tts', 'elevenlabs_tts', secondaryKey, 'secondary');

      const primaryFingerprint = await createProviderVerificationFingerprint(primary, primaryKey);
      await saveSlotConnectionTestResult('voice_tts', {
        ok: true, slotId: 'voice_tts', providerId: 'openai_tts', tier: 1,
        label: 'Online AI', latencyMs: 1, message: 'PASS — API 1',
        verificationFingerprint: primaryFingerprint ?? undefined
      });

      const secondary = {
        providerId: 'elevenlabs_tts',
        baseUrl: 'https://api.elevenlabs.io/v1',
        modelOrVoice: 'voice-id',
        verified: true,
        testResult: {
          ok: true, latencyMs: 1, message: 'PASS — API 2', testedAt: Date.now(),
          verificationFingerprint: await createProviderVerificationFingerprint(
            { slotId: 'voice_tts', providerId: 'elevenlabs_tts', baseUrl: 'https://api.elevenlabs.io/v1', modelOrVoice: 'voice-id' },
            secondaryKey
          ) ?? undefined
        }
      };
      await saveSecondarySlotConfig('voice_tts', secondary);
      await markProviderAccountFailure(
        'voice_tts', failedAccount,
        Object.assign(new Error('HTTP 401 invalid API key'), { status: 401 })
      );

      const resolved = await resolveSlotTier({ ...primary, secondary }, { isOnline: true });
      expect(resolved.tier).toBe(1);
      expect(resolved.label).toBe('Online AI');
      expect(resolved.isFallback).toBe(false);
      expect(resolved.reason).toContain(failedAccount === 'primary' ? 'API 1' : 'API 2');
      expect(resolved.reason).toContain('alternate account is available');
    }
  });

  it.each([401, 404])('moves a verified TTS account to Needs re-test after HTTP %i', async status => {
    const config = {
      slotId: 'voice_tts' as const,
      providerId: 'openai_tts',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'tts-1:alloy'
    };
    await saveSlotConfig(config);
    await saveApiKey('voice_tts', 'openai_tts', 'runtime-health-key');
    await markSlotVerified('voice_tts', 'openai_tts');
    await markProviderAccountFailure('voice_tts', 'primary', Object.assign(new Error(`HTTP ${status}`), { status }));

    const resolved = await resolveSlotTier(config, { isOnline: true });
    expect(resolved.tier).toBe(3);
    expect(resolved.reason).toContain('re-test');
  });

  it('moves a verified TTS account into cooldown after HTTP 400', async () => {
    const config = {
      slotId: 'voice_tts' as const,
      providerId: 'openai_tts',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'tts-1:alloy'
    };
    await saveSlotConfig(config);
    await saveApiKey('voice_tts', 'openai_tts', 'runtime-400-key');
    await markSlotVerified('voice_tts', 'openai_tts');
    await markProviderAccountFailure('voice_tts', 'primary', Object.assign(new Error('HTTP 400'), { status: 400 }));
    const resolved = await resolveSlotTier(config, { isOnline: true });
    expect(resolved.tier).toBe(3);
    expect(resolved.reason).toContain('cooling down');
  });

  it('moves a verified TTS account into cooldown after HTTP 429', async () => {
    const config = {
      slotId: 'voice_tts' as const,
      providerId: 'openai_tts',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'tts-1:alloy'
    };
    await saveSlotConfig(config);
    await saveApiKey('voice_tts', 'openai_tts', 'runtime-cooldown-key');
    await markSlotVerified('voice_tts', 'openai_tts');
    await markProviderAccountFailure('voice_tts', 'primary', Object.assign(new Error('HTTP 429'), { status: 429 }));

    const resolved = await resolveSlotTier(config, { isOnline: true });
    expect(resolved.tier).toBe(3);
    expect(resolved.reason).toContain('cooling down');
  });

});
