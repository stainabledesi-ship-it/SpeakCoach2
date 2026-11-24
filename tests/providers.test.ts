import { beforeEach, describe, expect, it } from 'vitest';
import {
  createDefaultAllSlotsConfig,
  getOfflinePreset,
  getPreset,
  normalizeBaseUrl,
  SLOT_DEFINITIONS,
  SLOT_ORDER
} from '../src/config/providers';
import { hasConfiguredApiKey, loadApiKey, saveApiKey } from '../src/storage/keyStore';
import { loadAllSlotsConfig, saveSlotConfig } from '../src/storage/localStore';

describe('Provider Slots Configuration & Storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defines all 6 required provider slots with at least one online and one offline Tier 3 provider', () => {
    expect(SLOT_ORDER).toHaveLength(6);
    for (const slotId of SLOT_ORDER) {
      const def = SLOT_DEFINITIONS[slotId];
      expect(def.providers.length).toBeGreaterThanOrEqual(2);
      const offline = getOfflinePreset(slotId);
      expect(offline.tier).toBe(3);
      expect(offline.requiresKey).toBe(false);
    }
  });

  it('offers Groq WAV TTS and FreeTTS REST TTS without a model selector', () => {
    const groq = getPreset('voice_tts', 'groq_tts');
    const free = getPreset('voice_tts', 'freetts_tts');
    expect(groq.defaultBaseUrl).toBe('https://api.groq.com/openai/v1');
    expect(groq.defaultModelOrVoice).toBe('canopylabs/orpheus-v1-english');
    expect(free.defaultBaseUrl).toBe('https://freetts.org');
    expect(free.defaultModelOrVoice).toBe('');
    expect(free.modelSuggestions).toEqual([]);
  });

  it('normalizes trailing slashes from custom base URLs', () => {
    expect(normalizeBaseUrl('https://my-proxy.example.com/v1///')).toBe('https://my-proxy.example.com/v1');
    expect(normalizeBaseUrl('  https://api.openai.com/v1/  ')).toBe('https://api.openai.com/v1');
  });

  it('persists and sanitizes per-slot configuration in localStore', async () => {
    const defaults = createDefaultAllSlotsConfig();
    expect(defaults.llm_evaluator.providerId).toBe('openai_compat_eval');
    expect(defaults.llm_translation.providerId).toBe('openai_compat_translation');
    expect(getPreset('llm_translation', 'gemini_translation').defaultModelOrVoice).toBe('gemini-3.1-flash-lite');

    await saveSlotConfig({
      slotId: 'llm_evaluator',
      providerId: 'gemini_eval',
      baseUrl: 'https://my-gemini-gateway.example.org/v1beta/',
      modelOrVoice: 'gemini-2.5-pro'
    });

    const loaded = await loadAllSlotsConfig();
    expect(loaded.llm_evaluator.providerId).toBe('gemini_eval');
    expect(loaded.llm_evaluator.baseUrl).toBe('https://my-gemini-gateway.example.org/v1beta');
    expect(loaded.llm_evaluator.modelOrVoice).toBe('gemini-2.5-pro');
  });

  it('does not advertise a Vosk model that is not bundled with the app', () => {
    const offline = getPreset('pronunciation_scoring', 'offline_pronunciation');
    expect(offline.defaultModelOrVoice).toBe('android-offline');
    expect(offline.modelSuggestions).toEqual(['android-offline']);
    expect(offline.defaultBaseUrl).toBe('offline://android-speech-recognizer');
  });

  it('migrates previous official Gemini Translator defaults to Gemini 3.1 Flash Lite', async () => {
    localStorage.setItem('speakcoach.slots.config.v1', JSON.stringify({
      llm_translation: {
        providerId: 'gemini_translation',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        modelOrVoice: 'gemini-flash-latest'
      }
    }));

    const loaded = await loadAllSlotsConfig();
    expect(loaded.llm_translation.modelOrVoice).toBe('gemini-3.1-flash-lite');
    const persisted = JSON.parse(localStorage.getItem('speakcoach.slots.config.v1') || '{}');
    expect(persisted.llm_translation.modelOrVoice).toBe('gemini-3.1-flash-lite');
  });


  it('preserves a user-selected Gemini translation model instead of migrating it', async () => {
    localStorage.setItem('speakcoach.slots.config.v1', JSON.stringify({
      llm_translation: {
        providerId: 'gemini_translation',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        modelOrVoice: 'gemini-3-flash-preview'
      }
    }));

    const loaded = await loadAllSlotsConfig();
    expect(loaded.llm_translation.modelOrVoice).toBe('gemini-3-flash-preview');
  });

  it('stores and retrieves API keys per slot and provider in keyStore', async () => {
    expect(await hasConfiguredApiKey('voice_tts', 'openai_tts')).toBe(false);

    await saveApiKey('voice_tts', 'openai_tts', '  sk-test-12345  ');
    expect(await loadApiKey('voice_tts', 'openai_tts')).toBe('sk-test-12345');
    expect(await hasConfiguredApiKey('voice_tts', 'openai_tts')).toBe(true);

    const preset = getPreset('voice_tts', 'openai_tts');
    expect(preset.tier).toBe(1);

    await saveApiKey('voice_tts', 'openai_tts', '');
    expect(await hasConfiguredApiKey('voice_tts', 'openai_tts')).toBe(false);
  });
});
