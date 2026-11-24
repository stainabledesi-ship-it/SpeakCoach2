import type { HttpOptions, HttpResponse } from '@capacitor/core';
import { getPreset, normalizeBaseUrl } from '../config/providers';
import type { ConnectionTestResult, SlotConfig } from '../config/types';
import { loadApiKey } from '../storage/keyStore';
import { nativeHttpRequest, SpeakCoachHttpError } from './httpClient';
import { networkMonitor } from './networkMonitor';
import { clearSlotRuntimeFailure, markSlotRuntimeFailure } from './tierManager';
import { clearProviderAccountHealth, createProviderVerificationFingerprint, markProviderAccountFailure, type ProviderAccount } from './providerHealth';
import { saveSlotConnectionTestResult, saveSecondarySlotConfig } from '../storage/localStore';
import type { PersistedConnectionTestResult } from '../storage/localStore';
import { cleanJsonPayload } from './ieltsLlmEvaluator';
import { clearGeminiLanguageFailures, normalizeAudioDataUrl, synthesizeOnlineNeuralAudio } from './ttsService';
import { buildCapacitorMultipartEntries, parseWhisperWordTimestamps, requestAzurePronunciationAssessment } from './whisperSttService';
import {
  buildCustomEndpointRequest,
  buildGeminiEndpointRequest,
  redactUrlPathForDisplay,
  resolveWireFormat
} from './customEndpointHelper';

export type TransportFn = (opts: HttpOptions) => Promise<HttpResponse>;

/**
 * Generate a minimal valid WAV file containing `durationSeconds` of a pure
 * sine tone at `hz` Hz, 16-bit mono, 16 kHz.  Returns a base64 data-URI.
 * Generated at runtime so the probe has real audio data (non-zero samples)
 * and the binary multipart body will pass Groq/OpenAI validation.
 */
export function generateProbeWavBase64(durationSeconds = 1, hz = 440): string {
  const sampleRate = 16000;
  const numSamples = Math.round(sampleRate * durationSeconds);
  const dataSize = numSamples * 2; // 16-bit PCM = 2 bytes/sample
  const fileSize = 36 + dataSize; // RIFF chunk size field = fileSize - 8, but we store total

  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const enc = new TextEncoder();

  const writeStr = (offset: number, str: string) => {
    const bytes = enc.encode(str);
    for (let i = 0; i < bytes.length; i++) view.setUint8(offset + i, bytes[i]);
  };

  // RIFF header
  writeStr(0, 'RIFF');
  view.setUint32(4, fileSize, true);
  writeStr(8, 'WAVE');
  // fmt chunk
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);       // chunk size
  view.setUint16(20, 1, true);        // PCM
  view.setUint16(22, 1, true);        // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);        // block align
  view.setUint16(34, 16, true);       // bits/sample
  // data chunk
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  // samples: 440 Hz sine at 50% amplitude
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(16383 * Math.sin(2 * Math.PI * hz * i / sampleRate));
    view.setInt16(44 + i * 2, sample, true);
  }

  // base64-encode
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * @deprecated Use generateProbeWavBase64() instead — this constant has a
 * 0-byte data chunk and will cause HTTP 400 from Groq/OpenAI.
 * Kept only for backward-compatibility with old unit tests that check the
 * multipart body shape; do NOT send to real endpoints.
 */
export const BUNDLED_PROBE_WAV_BASE64 =
  'UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

/**
 * Expected phrase and probe input for STT deep test.
 */
export const STT_PROBE_EXPECTED_WORDS = ['hello', 'speak', 'test'];

/** Same capability probe is sent to every generator wire format. */
const GENERATOR_PROBE_PROMPT = [
  'Create a compact but valid IELTS Speaking test plan to verify question-generation capability.',
  'Return ONLY one JSON object with exactly these top-level fields: part1Questions, part2CueCard, part3Questions.',
  'part1Questions: 6 questions distributed across exactly 2 topics; every item must have non-empty topic and question strings.',
  'part2CueCard: an object with non-empty topic, title and prompt strings, plus exactly 4 non-empty string bullets.',
  'part3Questions: 4 questions; every item must have non-empty topic and question strings.',
  'Use natural, distinct, IELTS-appropriate questions. Do not add markdown or explanatory text.',
  'Example shape: {"part1Questions":[{"topic":"Daily routines","question":"How do you usually plan your day?"},{"topic":"Daily routines","question":"What part of the day do you enjoy most?"},{"topic":"Daily routines","question":"Has your daily routine changed recently?"},{"topic":"Public places","question":"Which public place do you visit most?"},{"topic":"Public places","question":"What makes a public place comfortable?"},{"topic":"Public places","question":"Should cities create more public spaces?"}],"part2CueCard":{"topic":"A useful object","title":"An object you use often","prompt":"Describe an object you use frequently.","bullets":["What it is","When you got it","How you use it","Why it is useful"]},"part3Questions":[{"topic":"Objects and daily life","question":"Why do people become attached to certain objects?"},{"topic":"Objects and daily life","question":"How have everyday objects changed in recent decades?"},{"topic":"Objects and daily life","question":"Should products be designed to last longer?"},{"topic":"Objects and daily life","question":"How does advertising influence what people buy?"}]}'
].join(' ');

function formatHttpFailure(err: unknown, defaultStep: string, slotId?: SlotConfig['slotId']): { step: string; status?: number; errorMsg: string } {
  if (err instanceof SpeakCoachHttpError) {
    let errorMsg = err.humanMessage;
    if (slotId === 'llm_evaluator' && err.status === 0) {
      errorMsg = 'Network request could not reach the provider. IELTS evaluation requires an online API; reconnect and verify the gateway.';
    }
    if (err.status === 401 || err.status === 403) {
      const redactedPath = err.requestUrl ? redactUrlPathForDisplay(err.requestUrl) : '';
      const snippet = err.responseDetail ? err.responseDetail.slice(0, 120) : '';
      const extraParts: string[] = [];
      if (redactedPath) extraParts.push(`Path: ${redactedPath}`);
      if (snippet) extraParts.push(`Response: ${snippet}`);
      if (extraParts.length > 0) {
        errorMsg = `${errorMsg} [${extraParts.join(' | ')}]`;
      }
    }
    return {
      step: defaultStep,
      status: err.status,
      errorMsg
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    step: defaultStep,
    errorMsg: msg
  };
}

export async function testSlotConnection(
  slotConfig: SlotConfig,
  options?: {
    apiKeyOverride?: string;
    isOnlineOverride?: boolean;
    transport?: TransportFn;
    recordRuntimeFailure?: boolean;
    account?: ProviderAccount;
  }
): Promise<ConnectionTestResult> {
  const startTime = Date.now();
  clearGeminiLanguageFailures(slotConfig.providerId);
  const preset = getPreset(slotConfig.slotId, slotConfig.providerId);
  const label = preset.tier === 3 ? 'Basic offline' : 'Online AI';

  if (preset.tier === 3) {
    clearSlotRuntimeFailure(slotConfig.slotId);
    if (slotConfig.slotId === 'llm_evaluator' || slotConfig.slotId === 'llm_translation') {
      const isTranslation = slotConfig.slotId === 'llm_translation';
      return {
        ok: false,
        slotId: slotConfig.slotId,
        providerId: preset.id,
        tier: 3,
        label: 'Basic offline',
        latencyMs: Math.max(1, Date.now() - startTime),
        message: isTranslation
          ? 'FAIL — Translation requires an online AI API. No offline translation engine is available; connect and verify a translation provider.'
          : 'FAIL — IELTS evaluation requires an online AI API. Offline IELTS evaluation is not available; connect and verify an online evaluator.'
      };
    }
    return {
      ok: true,
      slotId: slotConfig.slotId,
      providerId: preset.id,
      tier: 3,
      label: 'Basic offline',
      latencyMs: Math.max(1, Date.now() - startTime),
      message: `PASS — Built-in offline engine (${preset.name}) is ready on-device.`
    };
  }

  const online = options?.isOnlineOverride ?? networkMonitor.isOnline();
  if (!online) {
    return {
      ok: false,
      slotId: slotConfig.slotId,
      providerId: preset.id,
      tier: preset.tier,
      label,
      latencyMs: Math.max(1, Date.now() - startTime),
      message: 'FAIL — Step: Network Check. Device is in Airplane mode or offline. Active tier has auto-switched to Basic offline.'
    };
  }

  const apiKey = (
    options?.apiKeyOverride !== undefined
      ? options.apiKeyOverride
      : await loadApiKey(slotConfig.slotId, preset.id)
  ).trim();

  if (preset.requiresKey && !apiKey) {
    return {
      ok: false,
      slotId: slotConfig.slotId,
      providerId: preset.id,
      tier: preset.tier,
      label,
      latencyMs: Math.max(1, Date.now() - startTime),
      message: 'FAIL — Step: API Key Validation. API key is empty. Enter and save your API key first.'
    };
  }

  const baseUrl = normalizeBaseUrl(slotConfig.baseUrl || preset.defaultBaseUrl);
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    return {
      ok: false,
      slotId: slotConfig.slotId,
      providerId: preset.id,
      tier: preset.tier,
      label,
      latencyMs: Math.max(1, Date.now() - startTime),
      message: 'FAIL — Step: Configuration Validation. Base URL must start with https:// or http://.'
    };
  }

  let currentStep = 'HTTP Request';

  try {
    // -------------------------------------------------------------------------
    // 1. LLM Generator Slot (llm_generator)
    // -------------------------------------------------------------------------
    if (slotConfig.slotId === 'llm_generator') {
      currentStep = 'HTTP Request';
      let rawText = '';
      const wireFormat = resolveWireFormat({ ...slotConfig, baseUrl });

      if (wireFormat === 'gemini') {
        const model = (slotConfig.modelOrVoice || preset.defaultModelOrVoice).trim();
        const modelPath = model.startsWith('models/') ? model : `models/${model}`;
        const prepared = buildGeminiEndpointRequest({
          baseUrl,
          defaultPath: `/${modelPath}:generateContent`,
          apiKey,
          slotConfig
        });
        const res = await nativeHttpRequest<{
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        }>(
          {
            url: prepared.url,
            method: 'POST',
            headers: prepared.headers,
            data: {
              contents: [
                {
                  role: 'user',
                  parts: [
                    {
                      text: GENERATOR_PROBE_PROMPT
                    }
                  ]
                }
              ],
              generationConfig: {
                temperature: 0.0,
                responseMimeType: 'application/json'
              }
            },
            timeoutMs: 45000,
            maxRetries: 2,
            retryDelayMs: 1000
          },
          options?.transport
        );
        rawText = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      } else {
        // OpenAI / Groq / Custom OpenAI-compatible
        const model = (slotConfig.modelOrVoice || preset.defaultModelOrVoice).trim();
        const prepared = buildCustomEndpointRequest({
          baseUrl,
          defaultPath: '/chat/completions',
          apiKey,
          slotConfig,
          defaultHeaders: {
            'Content-Type': 'application/json'
          }
        });

        const res = await nativeHttpRequest<{
          choices?: Array<{ message?: { content?: string } }>;
        }>(
          {
            url: prepared.url,
            method: 'POST',
            headers: prepared.headers,
            data: {
              model,
              messages: [
                {
                  role: 'user',
                  content: GENERATOR_PROBE_PROMPT
                }
              ],
              temperature: 0.0,
              response_format: { type: 'json_object' }
            },
            timeoutMs: 45000,
            maxRetries: 2,
            retryDelayMs: 1000
          },
          options?.transport
        );
        rawText = res.data?.choices?.[0]?.message?.content ?? '';
      }

      currentStep = 'JSON Response Shape Validation';
      const cleaned = cleanJsonPayload(rawText);
      const parsed = JSON.parse(cleaned) as Record<string, unknown>;
      const part1 = Array.isArray(parsed.part1Questions) ? parsed.part1Questions as Array<Record<string, unknown>> : [];
      const part2 = parsed.part2CueCard as Record<string, unknown> | undefined;
      const part3 = Array.isArray(parsed.part3Questions) ? parsed.part3Questions as Array<Record<string, unknown>> : [];
      const part1Topics = new Set(part1.map(question => String(question.topic ?? '').trim().toLowerCase()).filter(Boolean));
      const bullets = Array.isArray(part2?.bullets) ? part2.bullets : [];
      if (
        part1.length < 6 || part1.length > 8 ||
        part1Topics.size !== 2 ||
        part1.some(question => typeof question.question !== 'string' || !question.question.trim()) ||
        !part2 || typeof part2.title !== 'string' || !part2.title.trim() ||
        typeof part2.prompt !== 'string' || !part2.prompt.trim() ||
        bullets.length !== 4 || bullets.some(bullet => typeof bullet !== 'string' || !bullet.trim()) ||
        part3.length < 4 || part3.length > 5 ||
        part3.some(question => typeof question.question !== 'string' || !question.question.trim())
      ) {
        throw new Error('Generator returned JSON, but it does not match the IELTS Speaking plan structure (Part 1: 6–8 questions across 2 topics; Part 2: title, prompt and 4 bullets; Part 3: 4–5 questions).');
      }
    }

    // -------------------------------------------------------------------------
    // 2. LLM Evaluator Slot (llm_evaluator)
    // -------------------------------------------------------------------------
    else if (slotConfig.slotId === 'llm_evaluator') {
      currentStep = 'HTTP Request';
      let rawText = '';
      // This is only a lightweight API capability check, not a full IELTS evaluation.
      // Keep the response tiny so connection testing does not consume unnecessary tokens
      // or time out while generating long feedback arrays and model answers.
      const samplePrompt =
        'This is a short API connection test, not a real IELTS assessment. ' +
        'Return ONLY a JSON object with exactly these three numeric fields, each between 0 and 9: ' +
        '{"fluencyCoherenceBand":6.5,"lexicalResourceBand":6.5,"grammaticalRangeBand":6.5}. ' +
        'Do not include comments, corrections, examples, or arrays.';

      const wireFormat = resolveWireFormat({ ...slotConfig, baseUrl });

      if (wireFormat === 'gemini') {
        const model = (slotConfig.modelOrVoice || preset.defaultModelOrVoice).trim();
        const modelPath = model.startsWith('models/') ? model : `models/${model}`;
        const prepared = buildGeminiEndpointRequest({
          baseUrl,
          defaultPath: `/${modelPath}:generateContent`,
          apiKey,
          slotConfig
        });
        const res = await nativeHttpRequest<{
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        }>(
          {
            url: prepared.url,
            method: 'POST',
            headers: prepared.headers,
            data: {
              contents: [{ role: 'user', parts: [{ text: samplePrompt }] }],
              generationConfig: {
                temperature: 0.1,
                responseMimeType: 'application/json'
              }
            },
            timeoutMs: 45000,
            maxRetries: 0
          },
          options?.transport
        );
        rawText = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      } else {
        // OpenAI / Groq / Custom OpenAI-compatible
        const model = (slotConfig.modelOrVoice || preset.defaultModelOrVoice).trim();
        const prepared = buildCustomEndpointRequest({
          baseUrl,
          defaultPath: '/chat/completions',
          apiKey,
          slotConfig,
          defaultHeaders: {
            'Content-Type': 'application/json'
          }
        });

        const res = await nativeHttpRequest<{
          choices?: Array<{ message?: { content?: string } }>;
        }>(
          {
            url: prepared.url,
            method: 'POST',
            headers: prepared.headers,
            data: {
              model,
              messages: [{ role: 'user', content: samplePrompt }],
              temperature: 0.1,
              response_format: { type: 'json_object' }
            },
            timeoutMs: 45000,
            maxRetries: 0
          },
          options?.transport
        );
        rawText = res.data?.choices?.[0]?.message?.content ?? '';
      }

      currentStep = 'JSON Schema Validation';
      const cleaned = cleanJsonPayload(rawText);
      const parsed = JSON.parse(cleaned) as Record<string, unknown>;

      if (
        typeof parsed.fluencyCoherenceBand !== 'number' ||
        typeof parsed.lexicalResourceBand !== 'number' ||
        typeof parsed.grammaticalRangeBand !== 'number'
      ) {
        throw new Error(
          `Evaluator response missing numeric band scores (fluencyCoherenceBand, lexicalResourceBand, grammaticalRangeBand)`
        );
      }
      for (const field of ['fluencyCoherenceBand', 'lexicalResourceBand', 'grammaticalRangeBand']) {
        const score = parsed[field];
        if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 9) {
          throw new Error(`Evaluator response contains an invalid ${field}; expected a number from 0 to 9.`);
        }
      }
    }

    // -------------------------------------------------------------------------
    // 3. Translation Slot (llm_translation)
    // -------------------------------------------------------------------------
    else if (slotConfig.slotId === 'llm_translation') {
      currentStep = 'HTTP Request';
      const probePrompt = 'Translate the English word "hello" into Persian. Return only the translation, without quotation marks or explanation.';
      const wireFormat = resolveWireFormat({ ...slotConfig, baseUrl });
      let translated = '';
      if (wireFormat === 'gemini') {
        const model = (slotConfig.modelOrVoice || preset.defaultModelOrVoice).trim();
        const modelPath = model.startsWith('models/') ? model : 'models/' + model;
        const prepared = buildGeminiEndpointRequest({ baseUrl, defaultPath: '/' + modelPath + ':generateContent', apiKey, slotConfig });
        const res = await nativeHttpRequest<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>({
          url: prepared.url, method: 'POST', headers: prepared.headers,
          data: { contents: [{ role: 'user', parts: [{ text: probePrompt }] }], generationConfig: { temperature: 0.1 } },
          timeoutMs: 45000, maxRetries: 1
        }, options?.transport);
        translated = res.data?.candidates?.[0]?.content?.parts?.map((part: any) => typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n') ?? '';
      } else {
        const model = (slotConfig.modelOrVoice || preset.defaultModelOrVoice).trim();
        const prepared = buildCustomEndpointRequest({ baseUrl, defaultPath: '/chat/completions', apiKey, slotConfig, defaultHeaders: { 'Content-Type': 'application/json' } });
        const res = await nativeHttpRequest<{ choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> }>({
          url: prepared.url, method: 'POST', headers: prepared.headers,
          data: { model, messages: [{ role: 'system', content: 'You are a precise translator. Return only the translation, without explanations or labels.' }, { role: 'user', content: probePrompt }], temperature: 0.1 },
          timeoutMs: 45000, maxRetries: 1
        }, options?.transport);
        const content = res.data?.choices?.[0]?.message?.content ?? '';
        translated = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: any) => part.text ?? '').filter(Boolean).join('\n') : '';
      }
      currentStep = 'Translation Response Validation';
      if (typeof translated !== 'string' || !translated.trim()) throw new Error('Translation provider returned an empty response to the translation probe.');
    }
    // -------------------------------------------------------------------------
    // 4. STT Slot (ielts_stt)
    // -------------------------------------------------------------------------
    else if (slotConfig.slotId === 'ielts_stt') {
      currentStep = 'HTTP Request';
      const model = (slotConfig.modelOrVoice || preset.defaultModelOrVoice).trim();

      if (preset.id === 'gemini_stt' || resolveWireFormat({ ...slotConfig, baseUrl }) === 'gemini') {
        const modelPath = model.startsWith('models/') ? model : `models/${model}`;
        const preparedGemini = buildGeminiEndpointRequest({
          baseUrl,
          defaultPath: `/${modelPath}:generateContent`,
          apiKey,
          slotConfig
        });
        const probeWavBase64 = generateProbeWavBase64(1, 440);
        const cleanBase64 = probeWavBase64.includes(',') ? probeWavBase64.split(',')[1] ?? '' : probeWavBase64;
        const res = await nativeHttpRequest<{
          candidates?: Array<{ content?: { parts?: Array<{ text?: string; audioTranscription?: { text?: string } }> } }>;
        }>(
          {
            url: preparedGemini.url,
            method: 'POST',
            headers: preparedGemini.headers,
            data: {
              contents: [{
                role: 'user',
                parts: [
                  { text: 'Transcribe the attached audio exactly as spoken.' },
                  { inlineData: { mimeType: 'audio/wav', data: cleanBase64 } }
                ]
              }],
              generationConfig: {
                temperature: 0,
                audioTranscriptionConfig: { mode: 'VERBATIM' }
              }
            },
            timeoutMs: 60000,
            maxRetries: 1
          },
          options?.transport
        );
        currentStep = 'STT Response Validation';
        if (!Array.isArray(res.data?.candidates) || res.data.candidates.length === 0) {
          throw new Error('Gemini STT response did not contain candidates.');
        }
      } else {
        // Generate a 1-second probe WAV with real audio samples at runtime.
        // The old BUNDLED_PROBE_WAV_BASE64 had a 0-byte data chunk which caused
        // HTTP 400 from Groq/OpenAI; generateProbeWavBase64() emits real PCM.
        const probeWavBase64 = generateProbeWavBase64(1, 440);
        const boundary = `----SpeakCoachWhisperProbe${Date.now()}`;
        const formDataEntries = buildCapacitorMultipartEntries({
          fields: [
            { name: 'model', value: model },
            { name: 'response_format', value: 'verbose_json' }
          ],
          fileField: {
            name: 'file',
            filename: 'sample.wav',
            contentType: 'audio/wav',
            dataBase64: probeWavBase64
          }
        });
  
        const prepared = buildCustomEndpointRequest({
          baseUrl,
          defaultPath: '/audio/transcriptions',
          apiKey,
          slotConfig,
          defaultHeaders: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`
          }
        });
  
        const res = await nativeHttpRequest<Record<string, unknown>>(
          {
            url: prepared.url,
            method: 'POST',
            headers: prepared.headers,
            data: formDataEntries,
            dataType: 'formData',
            timeoutMs: 60000,
            maxRetries: 2,
            retryDelayMs: 1000
          },
          options?.transport
        );
  
        currentStep = 'STT Response Validation';
        const parsed = parseWhisperWordTimestamps(res.data);
        // Valid Whisper responses contain either a transcript property or duration / segments / words array
        if (!res.data || (typeof res.data !== 'object' && typeof res.data !== 'string')) {
          throw new Error('STT response was not valid JSON or text');
        }
        // Note: With silence or mock speech, transcript might be empty or words found, but HTTP and shape succeeded
        if (typeof (res.data as Record<string, unknown>).text !== 'string' && parsed.words.length === 0 && !parsed.transcript) {
          // If neither text nor words present, check if text key existed
          if (!('text' in (res.data as Record<string, unknown>))) {
            throw new Error('STT response missing "text" property');
          }
  
      }
      }
    }

    // -------------------------------------------------------------------------
    // 4. TTS Slot (voice_tts)
    // -------------------------------------------------------------------------
    else if (slotConfig.slotId === 'voice_tts') {
      currentStep = 'HTTP Request';
      const testPhrase = 'Hello from SpeakCoach.';
      let dataUrl = '';

      if (preset.id === 'groq_tts' || preset.id === 'freetts_tts' || preset.id === 'gemini_tts') {
        // Groq and FreeTTS must use the exact synthesis adapters used by Preview/playback:
        // Groq requires WAV; FreeTTS requires create-job then download-file.
        const synthRes = await synthesizeOnlineNeuralAudio(
          testPhrase,
          slotConfig,
          apiKey,
          1.0,
          options?.transport,
          'en-US',
          false,
          undefined,
          true,
          45000
        );
        if (synthRes.fromCache) {
          throw new Error('Connection test must make a live network request; cached TTS audio cannot verify provider connectivity.');
        }
        dataUrl = synthRes.dataUrl;
      } else if (preset.id === 'azure_tts') {
        const voiceName = (slotConfig.modelOrVoice || preset.defaultModelOrVoice).trim();
        const ssml = `<speak version='1.0' xml:lang='en-US'><voice name='${voiceName}'>${testPhrase}</voice></speak>`;

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
            timeoutMs: 12000,
            maxRetries: 1
          },
          options?.transport
        );
        dataUrl = normalizeAudioDataUrl(res.data);
      } else if (preset.id === 'elevenlabs_tts') {
        const [voiceIdPart, modelIdPart] = (slotConfig.modelOrVoice || preset.defaultModelOrVoice).split(':');
        const voiceId = voiceIdPart?.trim() || preset.defaultModelOrVoice;
        const modelId = modelIdPart?.trim() || 'eleven_multilingual_v2';

        const res = await nativeHttpRequest<string>(
          {
            url: `${baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}`,
            method: 'POST',
            headers: {
              'xi-api-key': apiKey,
              'Content-Type': 'application/json',
              Accept: 'audio/mpeg'
            },
            data: { text: testPhrase, model_id: modelId },
            responseType: 'blob',
            timeoutMs: 12000,
            maxRetries: 1
          },
          options?.transport
        );
        dataUrl = normalizeAudioDataUrl(res.data);
      } else {
        // OpenAI TTS / Custom OpenAI-compatible TTS
        let model = 'tts-1';
        let voice = slotConfig.customTtsVoice?.trim() || 'alloy';

        if (slotConfig.modelOrVoice.includes(':')) {
          const [modelPart, voicePart] = slotConfig.modelOrVoice.split(':');
          model = modelPart?.trim() || 'tts-1';
          voice = slotConfig.customTtsVoice?.trim() || voicePart?.trim() || 'alloy';
        } else if (slotConfig.modelOrVoice.trim()) {
          model = slotConfig.modelOrVoice.trim();
        }

        const prepared = buildCustomEndpointRequest({
          baseUrl,
          defaultPath: '/audio/speech',
          apiKey,
          slotConfig,
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
              input: testPhrase,
              response_format: 'mp3'
            },
            responseType: 'blob',
            timeoutMs: 12000,
            maxRetries: 1
          },
          options?.transport
        );
        dataUrl = normalizeAudioDataUrl(res.data);
      }

      currentStep = 'Audio Synthesis Validation';
      if (!dataUrl || !dataUrl.startsWith('data:audio/') || dataUrl.length < 30) {
        throw new Error('TTS returned empty or invalid audio data URL');
      }
    }

    // -------------------------------------------------------------------------
    // 5. Pronunciation Scoring Slot (pronunciation_scoring)
    // -------------------------------------------------------------------------
    else {
      currentStep = 'HTTP Request';
      if (preset.id === 'azure_pronunciation') {
        const azureProbe = await requestAzurePronunciationAssessment({
          slotConfig,
          apiKey,
          wavBase64: generateProbeWavBase64(1, 440),
          durationMs: 1000,
          referenceText: 'Hello from SpeakCoach.',
          allowNoMatch: true,
          transport: options?.transport
        });
        if (!['Success', 'NoMatch', 'InitialSilenceTimeout', 'BabbleTimeout'].includes(azureProbe.recognitionStatus)) {
          throw new Error(`Unexpected Azure pronunciation assessment status: ${azureProbe.recognitionStatus}`);
        }
      } else if (resolveWireFormat({ ...slotConfig, baseUrl }) === 'gemini') {
        // Gemini audio endpoint test for Shadowing's independent provider slot.
        const model = (slotConfig.modelOrVoice || preset.defaultModelOrVoice).trim();
        const modelPath = model.startsWith('models/') ? model : `models/${model}`;
        const preparedGemini = buildGeminiEndpointRequest({
          baseUrl,
          defaultPath: `/${modelPath}:generateContent`,
          apiKey,
          slotConfig
        });
        const probeWavBase64 = generateProbeWavBase64(1, 440);
        const cleanBase64 = probeWavBase64.includes(',') ? probeWavBase64.split(',')[1] ?? '' : probeWavBase64;
        const res = await nativeHttpRequest<{
          candidates?: Array<{ content?: { parts?: Array<{ text?: string; audioTranscription?: { text?: string } }> } }>;
        }>(
          {
            url: preparedGemini.url,
            method: 'POST',
            headers: preparedGemini.headers,
            data: {
              contents: [{
                role: 'user',
                parts: [
                  { text: 'This connection test intentionally sends a synthetic tone, not human speech. Do not invent a transcript. Reply in plain text confirming that the audio input was received and that no speech transcript can be verified from this probe.' },
                  { inlineData: { mimeType: 'audio/wav', data: cleanBase64 } }
                ]
              }],
              generationConfig: { temperature: 0 }
            },
            timeoutMs: 60000,
            maxRetries: 1
          },
          options?.transport
        );
        if (!Array.isArray(res.data?.candidates) || res.data.candidates.length === 0) {
          throw new Error('Gemini STT response did not contain candidates.');
        }
        const responseParts = res.data.candidates.flatMap(candidate => candidate.content?.parts ?? []);
        if (responseParts.length === 0) {
          throw new Error('Gemini accepted the HTTP request but returned no candidate content parts.');
        }
      } else {
        // Exercise the same transcription endpoint used during Shadowing,
        // rather than treating a successful /models listing as proof that STT works.
        const model = (slotConfig.modelOrVoice || preset.defaultModelOrVoice).trim();
        const probeWavBase64 = generateProbeWavBase64(1, 440);
        const boundary = `----SpeakCoachPronunciationProbe${Date.now()}`;
        const formDataEntries = buildCapacitorMultipartEntries({
          fields: [
            { name: 'model', value: model },
            { name: 'response_format', value: 'verbose_json' },
            { name: 'timestamp_granularities[]', value: 'word' },
            { name: 'language', value: 'en' }
          ],
          fileField: {
            name: 'file',
            filename: 'sample.wav',
            contentType: 'audio/wav',
            dataBase64: probeWavBase64
          }
        });
        const prepared = buildCustomEndpointRequest({
          baseUrl,
          defaultPath: '/audio/transcriptions',
          apiKey,
          slotConfig,
          defaultHeaders: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`
          }
        });
        const res = await nativeHttpRequest<Record<string, unknown>>(
          {
            url: prepared.url,
            method: 'POST',
            headers: prepared.headers,
            data: formDataEntries,
            dataType: 'formData',
            responseType: 'json',
            timeoutMs: 60000,
            maxRetries: 1
          },
          options?.transport
        );
        currentStep = 'Pronunciation STT Response Validation';
        if (!res.data || typeof res.data !== 'object' || typeof res.data.text !== 'string') {
          throw new Error('Pronunciation STT endpoint did not return the expected verbose_json transcript field.');
        }
        if (res.data.words !== undefined && !Array.isArray(res.data.words)) {
          throw new Error('Pronunciation STT endpoint returned an invalid word-timestamp list.');
        }
      }
    }

    const latencyMs = Math.max(1, Date.now() - startTime);
    clearSlotRuntimeFailure(slotConfig.slotId);
    if (options?.account) await clearProviderAccountHealth(slotConfig.slotId, options.account);
    const verificationFingerprint = await createProviderVerificationFingerprint(slotConfig, apiKey);
    return {
      ok: true,
      slotId: slotConfig.slotId,
      providerId: preset.id,
      tier: preset.tier,
      label,
      latencyMs,
      verificationFingerprint: verificationFingerprint ?? undefined,
      message: preset.id === 'azure_pronunciation'
        ? `PASS — ${preset.name} pronunciation-assessment endpoint accepted the WAV probe (${latencyMs} ms). The probe is a synthetic tone; use a real spoken recording to verify recognition quality and pronunciation scores.`
        : slotConfig.slotId === 'ielts_stt' || slotConfig.slotId === 'pronunciation_scoring'
          ? `PASS — ${preset.name} transcription endpoint accepted the probe audio and returned the expected response shape (${latencyMs} ms). The probe is a synthetic tone, not human speech; this verifies API request/response only, not speech-recognition accuracy.`
          : `PASS — ${preset.name} test passed (capability probe, ${latencyMs} ms).`
    };
  } catch (err) {
    const latencyMs = Math.max(1, Date.now() - startTime);
    const failureInfo = formatHttpFailure(err, currentStep, slotConfig.slotId);
    const httpStatusStr = failureInfo.status ? ` (HTTP ${failureInfo.status})` : '';
    const failureMsg = `Step: ${failureInfo.step}${httpStatusStr} — ${failureInfo.errorMsg}`;

    if (options?.recordRuntimeFailure) {
      markSlotRuntimeFailure(slotConfig.slotId, failureMsg, {
        status: failureInfo.status
      });
    }
    if (options?.account) {
      const healthError = new Error(failureMsg) as Error & { status?: number };
      healthError.status = failureInfo.status;
      await markProviderAccountFailure(slotConfig.slotId, options.account, healthError);
    }
    return {
      ok: false,
      slotId: slotConfig.slotId,
      providerId: preset.id,
      tier: preset.tier,
      label,
      latencyMs,
      message: slotConfig.slotId === 'llm_evaluator'
        ? `FAIL — ${failureMsg} (${latencyMs} ms). IELTS evaluation requires an online API; no offline evaluator is available. This connection test does not activate a fallback.`
        : slotConfig.slotId === 'llm_translation'
          ? `FAIL — ${failureMsg} (${latencyMs} ms). Translation requires an online API; no offline translation engine is available. This connection test does not activate a fallback.`
          : `FAIL — ${failureMsg} (${latencyMs} ms). This connection test does not itself activate an offline fallback.`
    };
  }
}


/** Persist a completed probe through the same account-specific path used by Settings. */
export async function persistSlotAccountTestResult(
  slotConfig: SlotConfig,
  result: ConnectionTestResult,
  account: ProviderAccount
): Promise<PersistedConnectionTestResult | null> {
  const passed = result.ok && result.tier !== 3;
  if (passed) await clearProviderAccountHealth(slotConfig.slotId, account);
  if (account === 'primary') {
    return await saveSlotConnectionTestResult(slotConfig.slotId, { ...result, ok: passed });
  }
  const testResult = {
    ok: passed,
    latencyMs: result.latencyMs,
    message: result.message,
    testedAt: Date.now(),
    verificationFingerprint: result.verificationFingerprint
  };
  await saveSecondarySlotConfig(slotConfig.slotId, {
    ...slotConfig,
    verified: passed,
    testResult
  });
  if (!passed) {
    const status = Number(result.message.match(/HTTP\s+(\d{3})/i)?.[1]);
    const healthError = new Error(result.message) as Error & { status?: number };
    if (Number.isFinite(status) && status > 0) healthError.status = status;
    await markProviderAccountFailure(slotConfig.slotId, 'secondary', healthError);
  }
  return null;
}

/** Shared single-account probe + persistence path. */
export async function testAndPersistSlotAccount(
  slotConfig: SlotConfig,
  options: {
    account: ProviderAccount;
    apiKeyOverride?: string;
    isOnlineOverride?: boolean;
    transport?: TransportFn;
    persist?: boolean;
  }
): Promise<ConnectionTestResult> {
  const result = await testSlotConnection(slotConfig, options);
  if (options.persist !== false) await persistSlotAccountTestResult(slotConfig, result, options.account);
  return result;
}


export interface SlotAccountTestTarget {
  account: ProviderAccount;
  config: SlotConfig;
  apiKeyOverride?: string;
}

export interface SequentialSlotAccountTestResult {
  account: ProviderAccount;
  config: SlotConfig;
  result: ConnectionTestResult;
}

/** Run account probes serially, continue after per-account failures, and stop cleanly on cancellation. */
export async function testSlotAccountsSequentially(
  targets: SlotAccountTestTarget[],
  options: {
    pauseMs?: number;
    shouldCancel?: () => boolean;
    onProgress?: (current: number, total: number, target: SlotAccountTestTarget) => void;
    probe?: (target: SlotAccountTestTarget) => Promise<ConnectionTestResult>;
  } = {}
): Promise<{ results: SequentialSlotAccountTestResult[]; cancelled: boolean }> {
  const results: SequentialSlotAccountTestResult[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    if (options.shouldCancel?.()) return { results, cancelled: true };
    const target = targets[index];
    options.onProgress?.(index + 1, targets.length, target);
    let result: ConnectionTestResult;
    try {
      result = options.probe
        ? await options.probe(target)
        : await testAndPersistSlotAccount(target.config, {
            account: target.account,
            apiKeyOverride: target.apiKeyOverride,
            persist: false
          });
    } catch (error) {
      const preset = getPreset(target.config.slotId, target.config.providerId);
      result = {
        ok: false,
        slotId: target.config.slotId,
        providerId: target.config.providerId,
        tier: preset.tier,
        label: preset.tier === 3 ? 'Basic offline' : 'Online AI',
        latencyMs: 0,
        message: `FAIL — ${error instanceof Error ? error.message : String(error)}`
      };
    }
    results.push({ account: target.account, config: target.config, result });
    if (index < targets.length - 1 && (options.pauseMs ?? 0) > 0 && !options.shouldCancel?.()) {
      await new Promise(resolve => window.setTimeout(resolve, options.pauseMs));
    }
  }
  return { results, cancelled: Boolean(options.shouldCancel?.()) };
}


/** A slot can stay online when at least one configured account has a successful online verification. */
export function shouldPersistSlotVerification(
  results: Array<{ result: ConnectionTestResult }>,
  expectedAccountCount: number
): boolean {
  return expectedAccountCount > 0 &&
    results.length === expectedAccountCount &&
    results.some(item => item.result.ok && item.result.tier !== 3);
}


/** Turn a raw connection-probe failure into a plain-language cause and next step. */
export function describeConnectionTestFailure(result: ConnectionTestResult): string {
  if (result.ok && result.tier !== 3) return 'Connection passed.';
  const message = result.message || 'Unknown connection-test failure.';
  const status = Number(message.match(/HTTP\s+(\d{3})/i)?.[1]);
  if (status === 401 || status === 403) return `Key rejected (HTTP ${status}). Re-enter the API key in Settings and test again. Details: ${message}`;
  if (status === 404) return `Model or endpoint not found (HTTP 404). Check the model name, base URL and endpoint path. Details: ${message}`;
  if (status === 400) return `Bad request or unsupported capability (HTTP 400). Check the model, request format and whether this provider supports this feature. Details: ${message}`;
  if (status === 429) return `Quota or rate limit reached (HTTP 429). Wait for the provider limit to reset, reduce requests, or use API 2. Details: ${message}`;
  if (status === 408 || /timed?\s*out|timeout/i.test(message)) return `Connection timed out. Check the network and endpoint, wait briefly, then test again or use API 2. Details: ${message}`;
  if (status >= 500 && status <= 599) return `Provider server error (HTTP ${status}). Wait and retry, or use API 2. Details: ${message}`;
  if (/network|cors|fetch failed|connection refused|internet/i.test(message)) return `Network or CORS failure. Check the internet connection and provider endpoint, then retry. Details: ${message}`;
  return `Unclassified connection failure (possibly an app/provider compatibility issue). Keep the previous verification, report this error, and retry after checking the provider settings. Details: ${message}`;
}
