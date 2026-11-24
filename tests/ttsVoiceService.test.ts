import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAvailableTtsVoices, getBuiltInTtsVoices } from '../src/services/ttsVoiceService';

describe('TTS voice discovery', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('provides local voice catalogues for Gemini and OpenAI without a network call', async () => {
    const transport = vi.fn();
    const gemini = await fetchAvailableTtsVoices({
      slotId: 'voice_tts', providerId: 'gemini_tts',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelOrVoice: 'gemini-3.8-flash-lite-tts'
    }, 'gemini-key', { transport });
    const openai = await fetchAvailableTtsVoices({
      slotId: 'voice_tts', providerId: 'openai_tts',
      baseUrl: 'https://api.openai.com/v1', modelOrVoice: 'tts-1'
    }, 'openai-key', { transport });

    expect(gemini.voices.map((voice) => voice.value)).toContain('Puck');
    expect(openai.voices.map((voice) => voice.value)).toContain('alloy');
    expect(transport).not.toHaveBeenCalled();
  });

  it('loads Azure voice names and useful labels from the provider catalogue', async () => {
    const transport = vi.fn(async (options: any) => ({
      url: options.url, status: 200, headers: {},
      data: [{ ShortName: 'en-US-JennyNeural', DisplayName: 'Jenny', Locale: 'en-US', Gender: 'Female' }]
    }));
    const result = await fetchAvailableTtsVoices({
      slotId: 'voice_tts', providerId: 'azure_tts',
      baseUrl: 'https://eastus.tts.speech.microsoft.com',
      modelOrVoice: 'en-US-JennyNeural'
    }, 'azure-key', { transport });

    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list',
      method: 'GET',
      headers: { 'Ocp-Apim-Subscription-Key': 'azure-key' }
    }));
    expect(result.source).toBe('provider');
    expect(result.voices).toEqual([{ value: 'en-US-JennyNeural', label: 'Jenny · en-US · Female' }]);
  });

  it('loads ElevenLabs voice IDs and names from the provider catalogue', async () => {
    const transport = vi.fn(async (options: any) => ({
      url: options.url, status: 200, headers: {},
      data: { voices: [{ voice_id: 'voice-123', name: 'Rachel' }] }
    }));
    const result = await fetchAvailableTtsVoices({
      slotId: 'voice_tts', providerId: 'elevenlabs_tts',
      baseUrl: 'https://api.elevenlabs.io/v1',
      modelOrVoice: 'voice-123'
    }, 'eleven-key', { transport });

    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.elevenlabs.io/v1/voices',
      method: 'GET',
      headers: { 'xi-api-key': 'eleven-key' }
    }));
    expect(result.voices).toEqual([{ value: 'voice-123', label: 'Rachel · voice-123' }]);
  });

  it('rejects a missing key for providers whose voice catalogue is private', async () => {
    await expect(fetchAvailableTtsVoices({
      slotId: 'voice_tts', providerId: 'elevenlabs_tts',
      baseUrl: 'https://api.elevenlabs.io/v1', modelOrVoice: 'voice-123'
    }, '')).rejects.toThrow('Enter and save the API key');
  });

  it('keeps the built-in voice catalogue stable and non-empty', () => {
    expect(getBuiltInTtsVoices('gemini_tts').length).toBeGreaterThan(10);
  });

  it('provides the current Groq Orpheus voice choices locally', async () => {
    const transport = vi.fn();
    const result = await fetchAvailableTtsVoices({
      slotId: 'voice_tts', providerId: 'groq_tts',
      baseUrl: 'https://api.groq.com/openai/v1',
      modelOrVoice: 'canopylabs/orpheus-v1-english'
    }, 'groq-key', { transport });
    expect(result.voices.map(voice => voice.value)).toEqual(
      expect.arrayContaining(['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'])
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it('loads the public FreeTTS voice catalogue without an API key and normalizes an /api base URL', async () => {
    const transport = vi.fn(async (options: any) => ({
      url: options.url, status: 200, headers: {},
      data: [{ ShortName: 'en-US-JennyNeural', FriendlyName: 'Jenny', Locale: 'en-US', Gender: 'Female' }]
    }));
    const result = await fetchAvailableTtsVoices({
      slotId: 'voice_tts', providerId: 'freetts_tts',
      baseUrl: 'https://freetts.org/api', modelOrVoice: ''
    }, '', { transport });
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://freetts.org/api/voices',
      method: 'GET',
      headers: {}
    }));
    expect(result.voices).toEqual([{ value: 'en-US-JennyNeural', label: 'Jenny · en-US · Female' }]);
  });

});