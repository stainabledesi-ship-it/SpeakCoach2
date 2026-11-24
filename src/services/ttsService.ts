import { Capacitor, type HttpOptions, type HttpResponse } from '@capacitor/core';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { getPreset, normalizeBaseUrl } from '../config/providers';
import type { ResolvedSlotTier, SlotConfig } from '../config/types';
import { loadAllSlotsConfig } from '../storage/localStore';
import { loadApiKey } from '../storage/keyStore';
import { createAudioCacheAccountFingerprint, computeAudioCacheHash, getCachedTtsAudio, setCachedTtsAudio, setMemoryOnlyTtsAudio, removeMemoryOnlyTtsAudio } from './audioCache';
import { nativeHttpRequest, redactUrlForLog } from './httpClient';
import { executeWithTierFallback, resolveSlotTier } from './tierManager';
import { buildCustomEndpointRequest, buildGeminiEndpointRequest } from './customEndpointHelper';
import { runWithSlotApiFallback } from './apiFallback';
import { convertPcmBase64ToWavDataUrl } from './pcmWavHelper';
import { countShadowingLanguageUnits } from '../data/shadowingLanguages';
import { getActiveShadowingAudioSet, readActiveShadowingAudio, persistActiveShadowingAudio, markActiveSetAudioPlaying, releaseActiveSetAudioPlaying } from './shadowingAudioStore';
import { getElevenLabsLanguageCode, normalizeSpeechLocale } from './shadowingSpeechLanguage';

export interface SpeakResult {
  activeTier: ResolvedSlotTier;
  fromCache: boolean;
  durationEstimateMs: number;
  storageWarning?: string;
}

type TransportFn = (opts: HttpOptions) => Promise<HttpResponse>;

let activeHtmlAudio: HTMLAudioElement | null = null;
let activeHtmlAudioFinish: (() => void) | null = null;
let activePlaybackGeneration = 0;
let temporaryCacheGeneration = 0;
const temporaryCacheHashes = new Set<string>();
const prefetchTasks = new Map<string, Promise<boolean>>();
type SynthesizedAudioResult = { dataUrl: string; fromCache: boolean; cacheHash: string; persistedToActiveSet?: boolean };
const inFlightAudioRequests = new Map<string, Promise<SynthesizedAudioResult>>();
let userInitiatedSynthesisInFlight = 0;
const GEMINI_LANGUAGE_FAILURE_TTL_MS = 5 * 60 * 1000;
const geminiLanguageFailures = new Map<string, { message: string; expiresAt: number }>();

export function clearGeminiLanguageFailures(providerId?: string): void {
  if (!providerId || providerId === 'gemini_tts') geminiLanguageFailures.clear();
}

async function storeGeneratedAudio(
  hash: string,
  dataUrl: string,
  memoryOnly: boolean,
  cacheGeneration: number,
  cacheEnabled: boolean,
  setAudio?: { setId: string; generation: number; kind: 'sentence' | 'extra' }
): Promise<boolean> {
  if (memoryOnly && cacheGeneration !== temporaryCacheGeneration) return false;
  let persistedToActiveSet = !setAudio;
  if (setAudio) {
    if (!cacheEnabled) return false;
    try {
      persistedToActiveSet = await persistActiveShadowingAudio({ ...setAudio, hash, dataUrl });
      // A set switch invalidates this request completely: do not leak its
      // result into the generic LRU where the new set could accidentally reuse it.
      if (!persistedToActiveSet) return false;
    } catch (error) {
      persistedToActiveSet = false;
      console.warn('[ttsService] Could not persist active-set audio; continuing playback with the generated result.', error);
    }
  }
  if (!cacheEnabled) return persistedToActiveSet;
  if (memoryOnly) {
    if (cacheGeneration === temporaryCacheGeneration) {
      setMemoryOnlyTtsAudio(hash, dataUrl);
      temporaryCacheHashes.add(hash);
    }
    return persistedToActiveSet;
  }
  await setCachedTtsAudio(hash, dataUrl);
  return persistedToActiveSet;
}

export function stopAllTts(): void {
  activePlaybackGeneration++;
  if (activeHtmlAudio) {
    try {
      activeHtmlAudio.pause();
      activeHtmlAudio.currentTime = 0;
    } catch {
      // Ignore
    }
    activeHtmlAudio = null;
  }
  if (activeHtmlAudioFinish) {
    const finish = activeHtmlAudioFinish;
    activeHtmlAudioFinish = null;
    finish();
  }
  try {
    void TextToSpeech.stop().catch(() => {});
  } catch {
    // Ignore
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Ignore
    }
  }
}

export function normalizeAudioDataUrl(payload: unknown, mimeType = 'audio/mpeg'): string {
  if (typeof payload === 'string') {
    if (payload.startsWith('data:audio/')) return payload;
    return `data:${mimeType};base64,${payload}`;
  }
  return '';
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function findCachedActiveSetAudio(
  text: string,
  rate: number,
  locale: string,
  setAudio: { setId: string; generation: number; kind: 'sentence' | 'extra' },
  voiceSlot: SlotConfig
): Promise<{ dataUrl: string; hash: string; config: SlotConfig; preset: ReturnType<typeof getPreset>; persistedToActiveSet: boolean } | null> {
  const accounts: Array<{ config: SlotConfig; account: 'primary' | 'secondary' }> = [
    { config: voiceSlot, account: 'primary' },
    ...(voiceSlot.secondary ? [{ config: { slotId: 'voice_tts' as const, ...voiceSlot.secondary }, account: 'secondary' as const }] : [])
  ];
  for (const account of accounts) {
    const preset = getPreset('voice_tts', account.config.providerId);
    if (preset.tier === 3) continue;
    const key = await loadApiKey('voice_tts', account.config.providerId, account.account);
    const fingerprint = await createAudioCacheAccountFingerprint(key);
    if (!fingerprint) continue;
    const hash = computeAudioCacheHash({
      providerId: account.config.providerId,
      endpoint: account.config.baseUrl?.trim() ?? '',
      accountFingerprintHash: fingerprint,
      voiceOrModel: `${account.config.modelOrVoice}|${account.config.customTtsVoice?.trim() ?? ''}|${locale}`,
      rate,
      text
    });
    const fromSet = await readActiveShadowingAudio(hash, setAudio.setId);
    const dataUrl = fromSet ?? await getCachedTtsAudio(hash);
    if (!dataUrl) continue;
    let persistedToActiveSet = !!fromSet;
    if (!fromSet) {
      try { persistedToActiveSet = await persistActiveShadowingAudio({ ...setAudio, hash, dataUrl }); }
      catch (error) { console.warn('[ttsService] Could not copy an existing TTS cache entry into the active set store.', error); }
    }
    return { dataUrl, hash, config: account.config, preset, persistedToActiveSet };
  }
  return null;
}

export async function synthesizeOnlineNeuralAudio(
  text: string,
  slotCfg: SlotConfig,
  apiKey: string,
  rate = 1.0,
  transport?: TransportFn,
  locale = 'en-US',
  memoryOnly = false,
  cacheGeneration = temporaryCacheGeneration,
  bypassCache = false,
  requestTimeoutMs = 15000,
  setAudio?: { setId: string; generation: number; kind: 'sentence' | 'extra' }
): Promise<SynthesizedAudioResult> {
  // Explicit probes/previews must always issue their own live request. Normal
  // playback and prefetch share one promise so overlapping callers cannot
  // spend quota twice for the same account/model/voice/language/text/rate.
  const fingerprint = await createAudioCacheAccountFingerprint(apiKey);
  const languageFailureKey = `${slotCfg.providerId}|${slotCfg.baseUrl.trim()}|${slotCfg.modelOrVoice}|${slotCfg.customTtsVoice?.trim() ?? ''}|${fingerprint ?? ''}|${locale}`;
  const languageFailure = geminiLanguageFailures.get(languageFailureKey);
  if (!bypassCache && slotCfg.providerId === 'gemini_tts' && languageFailure) {
    if (languageFailure.expiresAt > Date.now()) throw new Error(languageFailure.message);
    geminiLanguageFailures.delete(languageFailureKey);
  }
  if (!fingerprint || bypassCache) {
    try {
      const result = await synthesizeOnlineNeuralAudioUnshared(
        text, slotCfg, apiKey, rate, transport, locale, memoryOnly, cacheGeneration, bypassCache, requestTimeoutMs, setAudio
      );
      if (slotCfg.providerId === 'gemini_tts') geminiLanguageFailures.delete(languageFailureKey);
      return result;
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? Number((error as { status?: unknown }).status) : undefined;
      if (slotCfg.providerId === 'gemini_tts' && (status === 400 || status === 404)) {
        geminiLanguageFailures.set(languageFailureKey, { message: error instanceof Error ? error.message : String(error), expiresAt: Date.now() + GEMINI_LANGUAGE_FAILURE_TTL_MS });
      }
      throw error;
    }
  }
  const hash = computeAudioCacheHash({
    providerId: slotCfg.providerId,
    voiceOrModel: `${slotCfg.modelOrVoice}|${slotCfg.customTtsVoice?.trim() ?? ''}|${locale}`,
    rate,
    text,
    endpoint: slotCfg.baseUrl?.trim() ?? '',
    accountFingerprintHash: fingerprint
  });
  const inFlightKey = `${hash}|generation:${cacheGeneration}|set:${setAudio?.setId ?? ''}:${setAudio?.generation ?? ''}`;
  const existing = inFlightAudioRequests.get(inFlightKey);
  if (existing) return existing;
  const request = synthesizeOnlineNeuralAudioUnshared(
    text, slotCfg, apiKey, rate, transport, locale, memoryOnly, cacheGeneration, false, requestTimeoutMs, setAudio
  );
  inFlightAudioRequests.set(inFlightKey, request);
  try {
    const result = await request;
    if (slotCfg.providerId === 'gemini_tts') geminiLanguageFailures.delete(languageFailureKey);
    return result;
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? Number((error as { status?: unknown }).status) : undefined;
    if (slotCfg.providerId === 'gemini_tts' && (status === 400 || status === 404)) {
      geminiLanguageFailures.set(languageFailureKey, { message: error instanceof Error ? error.message : String(error), expiresAt: Date.now() + GEMINI_LANGUAGE_FAILURE_TTL_MS });
    }
    throw error;
  } finally {
    if (inFlightAudioRequests.get(inFlightKey) === request) inFlightAudioRequests.delete(inFlightKey);
  }
}

async function synthesizeOnlineNeuralAudioUnshared(
  text: string,
  slotCfg: SlotConfig,
  apiKey: string,
  rate = 1.0,
  transport?: TransportFn,
  locale = 'en-US',
  memoryOnly = false,
  cacheGeneration = temporaryCacheGeneration,
  bypassCache = false,
  requestTimeoutMs = 15000,
  setAudio?: { setId: string; generation: number; kind: 'sentence' | 'extra' }
): Promise<SynthesizedAudioResult> {
  const accountFingerprint = await createAudioCacheAccountFingerprint(apiKey);
  // If Web Crypto is unavailable, synthesize normally but bypass cache so
  // audio from separate provider accounts can never share a cache namespace.
  const cacheEnabled = accountFingerprint !== null && !bypassCache;
  const hash = computeAudioCacheHash({
    providerId: slotCfg.providerId,
    voiceOrModel: `${slotCfg.modelOrVoice}|${slotCfg.customTtsVoice?.trim() ?? ''}|${locale}`,
    rate,
    text,
    endpoint: slotCfg.baseUrl?.trim() ?? '',
    accountFingerprintHash: accountFingerprint ?? undefined
  });

  const safeSetAudio = cacheEnabled ? setAudio : undefined;
  if (safeSetAudio) {
    const activeSetAudio = await readActiveShadowingAudio(hash, safeSetAudio.setId);
    if (activeSetAudio) return { dataUrl: activeSetAudio, fromCache: true, cacheHash: hash, persistedToActiveSet: true };
  }
  if (cacheEnabled) {
    const cached = await getCachedTtsAudio(hash);
    if (cached) {
      const persistedToActiveSet = safeSetAudio
        ? await persistActiveShadowingAudio({ ...safeSetAudio, hash, dataUrl: cached }).catch(() => false)
        : undefined;
      return { dataUrl: cached, fromCache: true, cacheHash: hash, persistedToActiveSet };
    }
  }

  const baseUrl = normalizeBaseUrl(slotCfg.baseUrl);

  if (slotCfg.providerId === 'freetts_tts') {
    const voice = slotCfg.customTtsVoice?.trim() || 'en-US-JennyNeural';
    const ratePercent = Math.max(-50, Math.min(100, Math.round((rate - 1) * 100)));
    const create = await nativeHttpRequest<{ file_id?: string } | string>(
      {
        url: `${baseUrl}/api/v1/tts`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        data: { text, voice, rate: `${ratePercent >= 0 ? '+' : ''}${ratePercent}%`, pitch: '+0Hz', output_format: 'mp3' },
        responseType: 'json',
        timeoutMs: requestTimeoutMs
      },
      transport
    );
    const payload = typeof create.data === 'string' ? JSON.parse(create.data) as { file_id?: string } : create.data;
    const fileId = typeof payload?.file_id === 'string' ? payload.file_id.trim() : '';
    if (!fileId) throw new Error('FreeTTS did not return a file_id. Check the API key and REST response.');
    const audio = await nativeHttpRequest<string>(
      {
        url: `${baseUrl}/api/audio/${encodeURIComponent(fileId)}`,
        method: 'GET',
        headers: { Accept: 'audio/mpeg' },
        responseType: 'blob',
        timeoutMs: requestTimeoutMs
      },
      transport
    );
    const dataUrl = normalizeAudioDataUrl(audio.data, 'audio/mpeg');
    if (!dataUrl) throw new Error('FreeTTS returned an empty MP3 download.');
    const persistedToActiveSet = await storeGeneratedAudio(hash, dataUrl, memoryOnly, cacheGeneration, cacheEnabled, setAudio);
    return { dataUrl, fromCache: false, cacheHash: hash, persistedToActiveSet: setAudio ? persistedToActiveSet : undefined };
  }

  if (slotCfg.providerId === 'openai_tts' || slotCfg.providerId === 'custom_openai_tts' || slotCfg.providerId === 'groq_tts') {
    let model = 'tts-1';
    let voice = slotCfg.customTtsVoice?.trim() || (slotCfg.providerId === 'groq_tts' ? 'troy' : 'alloy');

    if (slotCfg.modelOrVoice.includes(':')) {
      const [modelPart, voicePart] = slotCfg.modelOrVoice.split(':');
      model = modelPart?.trim() || 'tts-1';
      voice = slotCfg.customTtsVoice?.trim() || voicePart?.trim() || 'alloy';
    } else if (slotCfg.modelOrVoice.trim()) {
      model = slotCfg.modelOrVoice.trim();
    }

    if (slotCfg.providerId === 'groq_tts') {
      if (text.length > 200) {
        throw new Error('Groq Orpheus accepts up to 200 characters per request. Use another TTS provider for longer text.');
      }
      if (!slotCfg.customTtsVoice?.trim()) voice = model.includes('arabic') ? 'fahad' : 'troy';
    }

    const prepared = buildCustomEndpointRequest({
      baseUrl,
      defaultPath: '/audio/speech',
      apiKey,
      slotConfig: slotCfg,
      defaultHeaders: {
        'Content-Type': 'application/json'
      }
    });

    const res = await nativeHttpRequest<string>(
      {
        url: prepared.url,
        method: 'POST',
        headers: prepared.headers,
        data: {
          model,
          voice,
          input: text,
          speed: rate,
          response_format: slotCfg.providerId === 'groq_tts' ? 'wav' : 'mp3'
        },
        responseType: 'blob',
        timeoutMs: 15000
      },
      transport
    );
    const dataUrl = normalizeAudioDataUrl(res.data, slotCfg.providerId === 'groq_tts' ? 'audio/wav' : 'audio/mpeg');
    if (!dataUrl) throw new Error(`Empty audio payload from ${slotCfg.providerId === 'groq_tts' ? 'Groq' : slotCfg.providerId === 'custom_openai_tts' ? 'Custom OpenAI' : 'OpenAI'} TTS`);
    const persistedToActiveSet = await storeGeneratedAudio(hash, dataUrl, memoryOnly, cacheGeneration, cacheEnabled, setAudio);
    return { dataUrl, fromCache: false, cacheHash: hash, persistedToActiveSet: setAudio ? persistedToActiveSet : undefined };
  }

  if (slotCfg.providerId === 'gemini_tts') {
    const rawModel = (slotCfg.modelOrVoice || 'gemini-3.8-flash-lite-tts').trim();
    const model = rawModel.startsWith('models/') ? rawModel.slice('models/'.length) : rawModel;
    const voice = slotCfg.customTtsVoice?.trim() || 'Puck';

    // Gemini TTS model IDs evolve frequently. Do not maintain a closed
    // allow-list here: the provider's live model catalogue is the source of
    // truth. Keep a lightweight guard so a text-only model is not sent to the
    // audio-generation endpoint by mistake.
    if (!/(?:^|-)tts(?:-|$)/i.test(model)) {
      throw new Error(
        `Model "${model}" does not look like a Gemini TTS model. Use Fetch models and choose a model whose ID contains "tts".`
      );
    }

    const modelPath = model.startsWith('models/') ? model : `models/${model}`;
    const prepared = buildGeminiEndpointRequest({
      baseUrl,
      defaultPath: `/${modelPath}:generateContent`,
      apiKey,
      slotConfig: slotCfg
    });
    const url = prepared.url;

    console.debug(`[geminiTts] model=${model} voice=${voice} url=${redactUrlForLog(url)}`);

    const res = await nativeHttpRequest<{
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { data?: string; mimeType?: string };
            text?: string;
          }>;
        };
      }>;
    }>(
      {
        url,
        method: 'POST',
        headers: prepared.headers,
        data: {
          contents: [{
            role: 'user',
            parts: rate < 0.999
              ? [
                  { text: `Speak the following text slowly and clearly, at approximately ${Math.round(rate * 100)}% of normal speaking speed. Do not speak these instructions. Read the following text exactly, without adding, omitting, or paraphrasing words:` },
                  { text }
                ]
              : [{ text }]
          }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { languageCode: locale.split('-')[0].toLowerCase(), voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
          }
        },
        timeoutMs: requestTimeoutMs,
        maxRetries: 0 // No automatic retries for TTS — 429 retries waste quota
      },
      transport
    );

    // Log safe diagnostics (never log API key or audio data)
    const candidateCount = res.data?.candidates?.length ?? 0;
    const parts = res.data?.candidates?.[0]?.content?.parts ?? [];
    const partCount = parts.length;
    const audioPartIdx = parts.findIndex((p) => p.inlineData?.data);
    const hasMimeType = audioPartIdx >= 0 ? (parts[audioPartIdx].inlineData?.mimeType ?? 'none') : 'none';
    console.debug(
      `[geminiTts] HTTP ${res.status} model=${model} candidates=${candidateCount} parts=${partCount} audioPartIdx=${audioPartIdx} mimeType=${hasMimeType}`
    );

    // Find the audio part — it may be at any index, not necessarily parts[0]
    const inlineData = parts[audioPartIdx]?.inlineData;
    if (!inlineData?.data) {
      const responseKeys = Object.keys(res.data ?? {}).join(', ');
      throw new Error(
        `Gemini TTS returned no audio data. HTTP ${res.status} · model=${model} · candidateCount=${candidateCount} · partCount=${partCount} · responseKeys=[${responseKeys}]. Confirm model access and API key quota.`
      );
    }

    const mimeType = (inlineData.mimeType || 'audio/pcm').toLowerCase();
    const rawData = inlineData.data.trim();
    const cleanB64 = rawData.startsWith('data:') ? (rawData.split(',')[1] ?? rawData) : rawData;
    // If mimeType is audio/wav or data already has RIFF header, use as-is; otherwise wrap PCM in WAV
    const dataUrl = mimeType.includes('wav')
      ? `data:audio/wav;base64,${cleanB64}`
      : convertPcmBase64ToWavDataUrl(cleanB64, 24000);
    const persistedToActiveSet = await storeGeneratedAudio(hash, dataUrl, memoryOnly, cacheGeneration, cacheEnabled, setAudio);
    return { dataUrl, fromCache: false, cacheHash: hash, persistedToActiveSet: setAudio ? persistedToActiveSet : undefined };
  }

  if (slotCfg.providerId === 'azure_tts') {
    const voiceName = (slotCfg.customTtsVoice?.trim() || slotCfg.modelOrVoice || 'en-US-JennyNeural').trim();
    const langMatch = voiceName.match(/^([a-z]{2}-[A-Z]{2})/);
    if (langMatch && langMatch[1].toLowerCase() !== locale.toLowerCase()) {
      throw new Error(`The configured Azure voice ${voiceName} is for ${langMatch[1]}, not ${locale}. Select a matching voice in Azure or use the device voice.`);
    }
    const xmlLang = locale;
    const prosodyRatePct = `${Math.round((rate - 1) * 100)}%`;
    const ssml = `<speak version='1.0' xml:lang='${xmlLang}'><voice name='${escapeXml(
      voiceName
    )}'><prosody rate='${prosodyRatePct}'>${escapeXml(text)}</prosody></voice></speak>`;

    const res = await nativeHttpRequest<string>(
      {
        url: `${baseUrl}/cognitiveservices/v1`,
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': apiKey,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-16khz-64kbitrate-mono-mp3'
        },
        data: ssml,
        responseType: 'blob',
        timeoutMs: 15000
      },
      transport
    );
    const dataUrl = normalizeAudioDataUrl(res.data);
    if (!dataUrl) throw new Error('Empty audio payload from Azure Neural TTS');
    const persistedToActiveSet = await storeGeneratedAudio(hash, dataUrl, memoryOnly, cacheGeneration, cacheEnabled, setAudio);
    return { dataUrl, fromCache: false, cacheHash: hash, persistedToActiveSet: setAudio ? persistedToActiveSet : undefined };
  }

  if (slotCfg.providerId === 'elevenlabs_tts') {
    const [voiceIdPart, modelIdPart] = (slotCfg.modelOrVoice || '21m00Tcm4TlvDq8ikWAM').split(':');
    const voiceId = slotCfg.customTtsVoice?.trim() || voiceIdPart?.trim() || '21m00Tcm4TlvDq8ikWAM';
    const modelId = modelIdPart?.trim() || 'eleven_multilingual_v2';
    const languageCode = getElevenLabsLanguageCode(locale, modelId);
    if (!languageCode) {
      throw new Error(`ElevenLabs ${modelId} does not list ${locale} as a supported language. The device voice will be used instead.`);
    }

    const res = await nativeHttpRequest<string>(
      {
        url: `${baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}`,
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg'
        },
        data: {
          text,
          model_id: modelId,
          language_code: languageCode,
          ...(rate < 0.999 ? { voice_settings: { speed: Math.max(0.7, Math.min(1.2, rate)) } } : {})
        },
        responseType: 'blob',
        timeoutMs: 15000
      },
      transport
    );
    const dataUrl = normalizeAudioDataUrl(res.data);
    if (!dataUrl) throw new Error('Empty audio payload from ElevenLabs TTS');
    const persistedToActiveSet = await storeGeneratedAudio(hash, dataUrl, memoryOnly, cacheGeneration, cacheEnabled, setAudio);
    return { dataUrl, fromCache: false, cacheHash: hash, persistedToActiveSet: setAudio ? persistedToActiveSet : undefined };
  }

  throw new Error(`Unsupported online TTS provider: ${slotCfg.providerId}`);
}

export async function playAudioDataUrl(
  dataUrl: string,
  playbackRate = 1.0,
  safetyTimeoutMs = 30000,
  onPlaybackStart?: () => void
): Promise<void> {
  if (typeof Audio === 'undefined') return;
  stopAllTts();
  const currentGen = activePlaybackGeneration;
  await new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (activeHtmlAudioFinish === finish) {
        activeHtmlAudioFinish = null;
      }
      if (activeHtmlAudio === audio) {
        activeHtmlAudio = null;
      }
      resolve();
    };

    if (activePlaybackGeneration !== currentGen) {
      resolve();
      return;
    }

    let audio: HTMLAudioElement;
    try {
      audio = new Audio(dataUrl);
    } catch {
      resolve();
      return;
    }

    activeHtmlAudio = audio;
    activeHtmlAudioFinish = finish;
    audio.playbackRate = playbackRate;

    const onEnded = () => finish();
    const onError = () => finish();
    const onPlaying = () => onPlaybackStart?.();
    audio.onended = onEnded;
    audio.onerror = onError;
    if (typeof audio.addEventListener === 'function') {
      audio.addEventListener('ended', onEnded, { once: true });
      audio.addEventListener('error', onError, { once: true });
      audio.addEventListener('playing', onPlaying, { once: true });
    }

    timer = setTimeout(finish, safetyTimeoutMs);

    try {
      const playRes = audio.play();
      if (playRes && typeof playRes.then === 'function') {
        playRes.catch(() => finish());
      } else {
        finish();
      }
    } catch {
      finish();
    }
  });
}

export async function speakOfflineNativeTts(
  text: string,
  locale = 'en-US',
  rate = 1.0,
  safetyTimeoutMs = 30000,
  onPlaybackStart?: () => void
): Promise<void> {
  const cleanLang = normalizeSpeechLocale(locale);
  stopAllTts();

  // In browser preview, use SpeechSynthesis directly so its real onstart event
  // can dismiss the waiting-for-audio message.
  if (!Capacitor.isNativePlatform() && typeof window !== 'undefined' && 'speechSynthesis' in window) {
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve();
      };
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = cleanLang;
        utter.rate = rate;
        utter.onstart = () => onPlaybackStart?.();
        utter.onend = finish;
        utter.onerror = finish;
        timer = setTimeout(finish, safetyTimeoutMs);
        window.speechSynthesis.speak(utter);
      } catch {
        finish();
      }
    });
    return;
  }

  try {
    let started = false;
    let startListener: { remove: () => Promise<void> } | null = null;
    try {
      startListener = await TextToSpeech.addListener('onRangeStart', () => {
        if (!started) {
          started = true;
          onPlaybackStart?.();
        }
      });
    } catch {
      // Older native plugin implementations may not expose range-start events.
    }
    try {
      await TextToSpeech.speak({
        text,
        lang: cleanLang,
        rate,
        pitch: 1.0,
        volume: 1.0,
        category: 'ambient'
      });
    } finally {
      if (startListener) await startListener.remove().catch(() => {});
    }
    return;
  } catch {
    // Fallback to browser speechSynthesis when running in desktop browser preview
  }

  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve();
      };

      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = cleanLang;
        utter.rate = rate;
        utter.onstart = () => onPlaybackStart?.();
        utter.onend = () => finish();
        utter.onerror = () => finish();
        if (typeof utter.addEventListener === 'function') {
          utter.addEventListener('end', () => finish(), { once: true });
          utter.addEventListener('error', () => finish(), { once: true });
        }
        timer = setTimeout(finish, safetyTimeoutMs);
        window.speechSynthesis.speak(utter);
      } catch {
        finish();
      }
    });
  }
}

export async function speakSentenceWithTierFallback(
  text: string,
  options?: {
    rate?: number;
    transport?: TransportFn;
    onPlaybackStart?: () => void;
    locale?: string;
    shadowingSetAudio?: { setId: string; generation: number; kind: 'sentence' | 'extra' };
    onSynthesisStart?: () => void;
  }
): Promise<SpeakResult> {
  const playbackGeneration = activePlaybackGeneration;
  const rate = options?.rate ?? 1.0;
  const locale = normalizeSpeechLocale(options?.locale);
  const languageCode = locale.split('-')[0].toLowerCase();
  const wordCount = Math.max(1, countShadowingLanguageUnits(text, languageCode));
  const durationEstimateMs = Math.round(((wordCount * 380) / Math.max(0.5, rate)));

  const configs = await loadAllSlotsConfig();
  const voiceSlot = configs.voice_tts;

  // Durable active-set audio is checked before tier resolution so it remains
  // playable offline and in Tier 3 without contacting a provider.
  if (options?.shadowingSetAudio) {
    const cachedSetAudio = await findCachedActiveSetAudio(text, rate, locale, options.shadowingSetAudio, voiceSlot);
    if (cachedSetAudio) {
      const activeSet = await getActiveShadowingAudioSet();
      if (activeSet.setId !== options.shadowingSetAudio.setId || activeSet.generation !== options.shadowingSetAudio.generation) {
        return { activeTier: await resolveSlotTier(voiceSlot), fromCache: false, durationEstimateMs };
      }
      const resolved = await resolveSlotTier(voiceSlot);
      const cachedTier: ResolvedSlotTier = {
        ...resolved,
        providerId: cachedSetAudio.config.providerId,
        providerName: cachedSetAudio.preset.name,
        tier: cachedSetAudio.preset.tier,
        label: 'Online AI',
        detailLabel: `Cached audio · ${cachedSetAudio.preset.name}`,
        isFallback: false,
        reason: resolved.tier === 3 ? 'Playing saved generated audio while offline; no provider request was needed.' : undefined
      };
      markActiveSetAudioPlaying(options.shadowingSetAudio.setId, cachedSetAudio.hash);
      try {
        await playAudioDataUrl(cachedSetAudio.dataUrl, 1.0, 30000, options.onPlaybackStart);
      } finally {
        await releaseActiveSetAudioPlaying(options.shadowingSetAudio.setId, cachedSetAudio.hash);
      }
      return {
        activeTier: cachedTier,
        fromCache: true,
        durationEstimateMs,
        storageWarning: cachedSetAudio.persistedToActiveSet ? undefined : 'This generated audio could not be copied into durable active-set storage; replay may require an internet connection.'
      };
    }
  }

  let usedCache = false;
  let storageWarning: string | undefined;
  let activeSetAudioHash: string | null = null;
  const usedProviderConfig: { current: { config: SlotConfig; account: 'primary' | 'secondary' } | null } = { current: null };

  const outcome = await executeWithTierFallback(
    'voice_tts',
    async () => {
      const attempt = await runWithSlotApiFallback('voice_tts', voiceSlot, async (apiConfig, apiKey) => {
        userInitiatedSynthesisInFlight++;
        try {
          options?.onSynthesisStart?.();
          return await synthesizeOnlineNeuralAudio(text, apiConfig, apiKey, rate, options?.transport, locale, false, temporaryCacheGeneration, false, 15000, options?.shadowingSetAudio);
        } finally {
          userInitiatedSynthesisInFlight = Math.max(0, userInitiatedSynthesisInFlight - 1);
        }
      });
      usedProviderConfig.current = { config: attempt.config, account: attempt.account };
      const { dataUrl, fromCache, cacheHash, persistedToActiveSet } = attempt.result;
      activeSetAudioHash = cacheHash;
      if (options?.shadowingSetAudio) {
        const activeSet = await getActiveShadowingAudioSet();
        if (activeSet.setId !== options.shadowingSetAudio.setId || activeSet.generation !== options.shadowingSetAudio.generation) return true;
        if (persistedToActiveSet === false) { storageWarning = 'This generated audio could not be saved for offline replay. Check available device storage and try again.'; console.warn('[ttsService] Audio playback succeeded, but durable Shadowing storage was unavailable.', storageWarning); }
      }
      if (activePlaybackGeneration !== playbackGeneration) {
        // Playback was cancelled while network request was pending
        return true;
      }
      usedCache = fromCache;
      if (options?.shadowingSetAudio) markActiveSetAudioPlaying(options.shadowingSetAudio.setId, cacheHash);
      // The requested rate has already been applied during online synthesis
      // (provider speed setting or Gemini slow-speaking prompt). Playing the
      // generated file at the same reduced rate would slow it twice.
      try {
        await playAudioDataUrl(dataUrl, 1.0, 30000, options?.onPlaybackStart);
      } finally {
        if (options?.shadowingSetAudio && activeSetAudioHash) {
          await releaseActiveSetAudioPlaying(options.shadowingSetAudio.setId, activeSetAudioHash);
        }
      }
      return true;
    },
    async (fallbackTier) => {
      // Log quota / rate-limit errors prominently so they appear in diagnostics
      if (fallbackTier.reason && (fallbackTier.reason.includes('429') || fallbackTier.reason.toLowerCase().includes('quota') || fallbackTier.reason.toLowerCase().includes('rate limit'))) {
        console.warn(`[ttsService] Gemini TTS rate-limited (HTTP 429) — falling back to native TTS. ${fallbackTier.reason}`);
      }
      if (activePlaybackGeneration !== playbackGeneration) {
        // Playback was cancelled
        return true;
      }
      usedCache = false;
      await speakOfflineNativeTts(text, locale, rate, 30000, options?.onPlaybackStart);
      return true;
    }
  );

  const activeTier = usedProviderConfig.current && outcome.activeTier.tier !== 3
    ? {
        ...outcome.activeTier,
        providerId: usedProviderConfig.current.config.providerId,
        providerName: getPreset('voice_tts', usedProviderConfig.current.config.providerId).name,
        detailLabel: `Online AI (${usedProviderConfig.current.account === 'secondary' ? 'API 2 · ' : 'API 1 · '}Tier ${getPreset('voice_tts', usedProviderConfig.current.config.providerId).tier} · ${getPreset('voice_tts', usedProviderConfig.current.config.providerId).name})`,
        isFallback: usedProviderConfig.current.account === 'secondary'
      }
    : outcome.activeTier;
  return { activeTier, fromCache: usedCache, durationEstimateMs, storageWarning };
}


/** Play a short voice sample using the unsaved TTS slot configuration currently shown in Settings. */
export async function previewTtsVoice(
  slotConfig: SlotConfig,
  apiKey: string,
  text = 'Hello! This is a short preview of the selected text-to-speech voice.',
  locale = 'en-US'
): Promise<void> {
  const preset = getPreset('voice_tts', slotConfig.providerId);
  if (preset.tier >= 3) {
    await speakOfflineNativeTts(text, locale, 1);
    return;
  }
  if (preset.requiresKey && !apiKey.trim()) {
    throw new Error('Enter an API key before previewing this online voice.');
  }
  // Voice previews are user-initiated synthesis too; keep prefetch paused until
  // the provider request completes. The disposable preview bypasses the cache.
  const result = await (async () => {
    userInitiatedSynthesisInFlight++;
    try {
      return await synthesizeOnlineNeuralAudio(text, slotConfig, apiKey, 1, undefined, locale, true, temporaryCacheGeneration, true);
    } finally {
      userInitiatedSynthesisInFlight = Math.max(0, userInitiatedSynthesisInFlight - 1);
    }
  })();
  await playAudioDataUrl(result.dataUrl);
}

/**
 * Pre-synthesize one sentence into the bounded RAM layer and, when it belongs
 * to the active Shadowing set, the durable set-specific audio store.
 */
export async function preloadSentenceAudio(text: string, options?: { locale?: string; transport?: TransportFn; shadowingSetAudio?: { setId: string; generation: number; kind: 'sentence' | 'extra' } }): Promise<boolean> {
  const normalizedText = text.trim();
  if (!normalizedText) return false;
  const locale = normalizeSpeechLocale(options?.locale);
  const taskKey = `${options?.shadowingSetAudio?.setId ?? ''}:${options?.shadowingSetAudio?.generation ?? ''}|${locale}|${normalizedText}`;
  const existing = prefetchTasks.get(taskKey);
  if (existing) return existing;

  const generation = temporaryCacheGeneration;
  const task = Promise.resolve().then(async (): Promise<boolean> => {
    try {
      if (generation !== temporaryCacheGeneration || userInitiatedSynthesisInFlight > 0) return false;
      const configs = await loadAllSlotsConfig();
      if (options?.shadowingSetAudio) {
        const cached = await findCachedActiveSetAudio(normalizedText, 1, locale, options.shadowingSetAudio, configs.voice_tts);
        if (cached) return cached.persistedToActiveSet;
      }
      const resolved = await resolveSlotTier(configs.voice_tts);
      // Prefetch is opportunistic: never probe an offline/unverified provider.
      if (resolved.tier === 3 || userInitiatedSynthesisInFlight > 0) return false;
      const attempt = await runWithSlotApiFallback('voice_tts', configs.voice_tts, (apiConfig, apiKey) => {
        if (userInitiatedSynthesisInFlight > 0) {
          throw new Error('Shadowing prefetch deferred while user-initiated playback is in flight.');
        }
        return synthesizeOnlineNeuralAudio(normalizedText, apiConfig, apiKey, 1, options?.transport, locale, true, generation, false, 15000, options?.shadowingSetAudio);
      });
      return attempt.result.persistedToActiveSet !== false;
    } catch {
      // The caller stops the current batch on failure; playback can retry online.
      return false;
    } finally {
      prefetchTasks.delete(taskKey);
    }
  });
  prefetchTasks.set(taskKey, task);
  return task;
}

/** Drop only temporary prefetch entries; regular reusable TTS cache is untouched. */
export function clearPreloadedSentenceAudio(): void {
  temporaryCacheGeneration++;
  for (const hash of temporaryCacheHashes) removeMemoryOnlyTtsAudio(hash);
  temporaryCacheHashes.clear();
  prefetchTasks.clear();
}
