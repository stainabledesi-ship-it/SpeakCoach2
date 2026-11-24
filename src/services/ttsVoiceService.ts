import type { HttpOptions, HttpResponse } from '@capacitor/core';
import type { SlotConfig } from '../config/types';
import { normalizeBaseUrl } from '../config/providers';
import { nativeHttpRequest } from './httpClient';

export type TtsVoiceTransport = (options: HttpOptions) => Promise<HttpResponse>;

export interface TtsVoiceOption {
  value: string;
  label: string;
}

export interface TtsVoiceListResult {
  voices: TtsVoiceOption[];
  source: 'provider' | 'built-in';
  message: string;
}

const GEMINI_PREBUILT_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'
];

const OPENAI_PREBUILT_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx',
  'nova', 'sage', 'shimmer', 'verse', 'marin', 'cedar'
];

const AZURE_COMMON_VOICES = [
  'en-US-JennyNeural', 'en-US-GuyNeural', 'en-US-AriaNeural',
  'en-GB-SoniaNeural', 'en-GB-RyanNeural', 'en-AU-NatashaNeural'
];

function asOptions(values: string[]): TtsVoiceOption[] {
  return values.map((value) => ({ value, label: value }));
}

function parseJsonPayload(payload: unknown): any {
  if (typeof payload === 'string') {
    try { return JSON.parse(payload); } catch { return null; }
  }
  return payload;
}

export function getBuiltInTtsVoices(providerId: string): TtsVoiceOption[] {
  if (providerId === 'gemini_tts') return asOptions(GEMINI_PREBUILT_VOICES);
  if (providerId === 'openai_tts') return asOptions(OPENAI_PREBUILT_VOICES);
  if (providerId === 'custom_openai_tts') return asOptions(OPENAI_PREBUILT_VOICES);
  if (providerId === 'azure_tts') return asOptions(AZURE_COMMON_VOICES);
  if (providerId === 'android_native_tts') return asOptions(['en-US', 'en-GB', 'en-AU', 'en-IN']);
  return [];
}

export async function fetchAvailableTtsVoices(
  config: SlotConfig,
  apiKey: string,
  options?: { transport?: TtsVoiceTransport }
): Promise<TtsVoiceListResult> {
  const providerId = config.providerId;

  // Gemini and OpenAI expose fixed prebuilt voice sets rather than a voice-list
  // endpoint. Keep these catalogues local and do not make a paid API call.
  if (providerId === 'gemini_tts' || providerId === 'openai_tts' || providerId === 'custom_openai_tts') {
    const voices = getBuiltInTtsVoices(providerId);
    const isCustom = providerId === 'custom_openai_tts' && normalizeBaseUrl(config.baseUrl) !== 'https://api.openai.com/v1';
    return {
      voices,
      source: 'built-in',
      message: isCustom
        ? 'Common OpenAI-compatible voice suggestions loaded. Your custom endpoint may support a different set; manual voice entry remains available.'
        : 'Built-in voice catalogue loaded.'
    };
  }

  if (providerId !== 'azure_tts' && providerId !== 'elevenlabs_tts') {
    return {
      voices: getBuiltInTtsVoices(providerId),
      source: 'built-in',
      message: 'This provider does not expose a remote voice catalogue.'
    };
  }

  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Base URL must start with http:// or https://.');
  if (!apiKey.trim()) throw new Error('Enter and save the API key before loading this provider’s voices.');

  const isAzure = providerId === 'azure_tts';
  const url = isAzure
    ? `${baseUrl}/cognitiveservices/voices/list`
    : `${baseUrl}/voices`;
  const headers: Record<string, string> = isAzure
    ? { 'Ocp-Apim-Subscription-Key': apiKey.trim() }
    : { 'xi-api-key': apiKey.trim() };

  const response = await nativeHttpRequest<unknown>({
    url,
    method: 'GET',
    headers,
    timeoutMs: 15000,
    maxRetries: 1
  }, options?.transport);

  const payload = parseJsonPayload(response.data);
  let voices: TtsVoiceOption[] = [];
  if (isAzure && Array.isArray(payload)) {
    voices = payload
      .filter((voice: any) => typeof voice?.ShortName === 'string' && voice.ShortName.trim())
      .map((voice: any) => ({
        value: voice.ShortName.trim(),
        label: [voice.DisplayName, voice.Locale, voice.Gender].filter(Boolean).join(' · ') || voice.ShortName.trim()
      }));
  } else if (!isAzure && Array.isArray(payload?.voices)) {
    voices = payload.voices
      .filter((voice: any) => typeof voice?.voice_id === 'string' && voice.voice_id.trim())
      .map((voice: any) => ({
        value: voice.voice_id.trim(),
        label: typeof voice.name === 'string' && voice.name.trim()
          ? `${voice.name.trim()} · ${voice.voice_id.trim()}`
          : voice.voice_id.trim()
      }));
  }

  if (voices.length === 0) {
    throw new Error(isAzure
      ? 'Azure returned no voices. Check the region, key and endpoint.'
      : 'ElevenLabs returned no voices. Check the API key and account access.');
  }

  return {
    voices,
    source: 'provider',
    message: `Loaded ${voices.length} voices from ${isAzure ? 'Azure' : 'ElevenLabs'}.`
  };
}
