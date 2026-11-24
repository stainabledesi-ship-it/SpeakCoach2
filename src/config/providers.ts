import type { AllSlotsConfig, ProviderPreset, SlotConfig, SlotDefinition, SlotId } from './types';

export const SLOT_ORDER: SlotId[] = [
  'voice_tts',
  'pronunciation_scoring',
  'ielts_stt',
  'llm_evaluator',
  'llm_generator',
  'llm_translation'
];

export const SLOT_DEFINITIONS: Record<SlotId, SlotDefinition> = {
  voice_tts: {
    id: 'voice_tts',
    number: 1,
    title: '1. Voice (Text-to-Speech)',
    subtitle: 'Natural model voice for shadowing & IELTS examiner prompts',
    providers: [
      {
        id: 'openai_tts',
        name: 'OpenAI Neural TTS (Tier 1)',
        slotId: 'voice_tts',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultModelOrVoice: 'tts-1:alloy',
        modelSuggestions: ['tts-1:alloy', 'tts-1:nova', 'tts-1:echo', 'tts-1-hd:alloy', 'tts-1-hd:nova'],
        modelFieldLabel: 'Model:Voice (e.g. tts-1:alloy or tts-1-hd:nova)',
        baseUrlPlaceholder: 'https://api.openai.com/v1',
        description: 'Online neural TTS cached locally by hash(text+voice).'
      },
      {
        id: 'custom_openai_tts',
        name: 'Custom (OpenAI-compatible) TTS (Tier 1)',
        slotId: 'voice_tts',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultModelOrVoice: 'tts-1:alloy',
        modelSuggestions: ['tts-1:alloy', 'tts-1:echo', 'tts-1:fable', 'tts-1:onyx', 'tts-1:nova', 'tts-1:shimmer'],
        modelFieldLabel: 'Model:Voice or Model Name',
        baseUrlPlaceholder: 'https://your-custom-tts-gateway.com/v1',
        description: 'Custom OpenAI-compatible /audio/speech endpoint with free-text model, voice, and selectable auth.'
      },
      {
        id: 'groq_tts',
        name: 'Groq Orpheus TTS (WAV)',
        slotId: 'voice_tts',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://api.groq.com/openai/v1',
        defaultModelOrVoice: 'canopylabs/orpheus-v1-english',
        modelSuggestions: ['canopylabs/orpheus-v1-english', 'canopylabs/orpheus-arabic-saudi'],
        modelFieldLabel: 'Groq TTS model',
        baseUrlPlaceholder: 'https://api.groq.com/openai/v1',
        description: 'Groq Orpheus speech endpoint. Requests WAV output; English and Saudi Arabic model variants are available.'
      },
      {
        id: 'freetts_tts',
        name: 'FreeTTS REST API (MP3)',
        slotId: 'voice_tts',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://freetts.org',
        defaultModelOrVoice: '',
        modelSuggestions: [],
        modelFieldLabel: 'No model selection',
        baseUrlPlaceholder: 'https://freetts.org',
        description: 'Two-step REST TTS: submit text, receive a file ID, then download MP3. Enter a voice name below; no model ID is required.'
      },
      {
        id: 'azure_tts',
        name: 'Azure Neural TTS (Tier 1)',
        slotId: 'voice_tts',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://eastus.tts.speech.microsoft.com',
        defaultModelOrVoice: 'en-US-JennyNeural',
        modelSuggestions: ['en-US-JennyNeural', 'en-US-GuyNeural', 'en-GB-SoniaNeural', 'en-GB-RyanNeural', 'en-AU-NatashaNeural'],
        modelFieldLabel: 'Neural Voice Name (e.g. en-US-JennyNeural, en-GB-SoniaNeural)',
        baseUrlPlaceholder: 'https://<region>.tts.speech.microsoft.com',
        description: 'Microsoft Azure Cognitive Services Neural TTS.'
      },
      {
        id: 'elevenlabs_tts',
        name: 'ElevenLabs TTS (Tier 1)',
        slotId: 'voice_tts',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://api.elevenlabs.io/v1',
        defaultModelOrVoice: '21m00Tcm4TlvDq8ikWAM',
        modelSuggestions: ['21m00Tcm4TlvDq8ikWAM:eleven_multilingual_v2', 'AZnzlk1XvdvUeBnXmlld:eleven_multilingual_v2', 'EXAVITQu4vr4xnSDxMaL:eleven_multilingual_v2'],
        modelFieldLabel: 'Voice ID (or voiceId:modelId)',
        baseUrlPlaceholder: 'https://api.elevenlabs.io/v1',
        description: 'ElevenLabs neural speech synthesis with local audio cache.'
      },
      {
        id: 'gemini_tts',
        name: 'Google Gemini TTS (Tier 1)',
        slotId: 'voice_tts',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        defaultModelOrVoice: 'gemini-3.8-flash-lite-tts',
        modelSuggestions: ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'],
        modelFieldLabel: 'Gemini Model (Free-text model name)',
        baseUrlPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
        description: 'Google Gemini text-to-speech with customizable voices (Puck, Charon, Kore, Fenrir, Aoede).'
      },
      {
        id: 'android_native_tts',
        name: 'Android Native TextToSpeech (Tier 3 Offline)',
        slotId: 'voice_tts',
        tier: 3,
        requiresKey: false,
        defaultBaseUrl: 'offline://android-tts',
        defaultModelOrVoice: 'en-US',
        modelSuggestions: ['en-US', 'en-GB', 'en-AU', 'en-IN'],
        modelFieldLabel: 'Locale (en-US or en-GB)',
        baseUrlPlaceholder: 'offline://android-tts',
        description: 'Built-in on-device Android TTS engine with speech rate control.'
      }
    ]
  },
  pronunciation_scoring: {
    id: 'pronunciation_scoring',
    number: 2,
    title: '2. Shadowing: Speech-to-Text & Pronunciation Analysis',
    subtitle: 'Transcribes Shadowing audio, aligns words and timing, and analyzes pronunciation',
    providers: [
      {
        id: 'azure_pronunciation',
        name: 'Azure Pronunciation Assessment REST (Tier 1)',
        slotId: 'pronunciation_scoring',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://eastus.stt.speech.microsoft.com',
        defaultModelOrVoice: 'en-US',
        modelSuggestions: ['en-US', 'en-GB', 'en-AU'],
        modelFieldLabel: 'Language Locale (en-US or en-GB)',
        baseUrlPlaceholder: 'https://<region>.stt.speech.microsoft.com',
        description: 'Reference-text phoneme + word accuracy, fluency, prosody & offsets (16kHz PCM WAV).'
      },
      {
        id: 'whisper_alignment',
        name: 'Whisper STT + Word Alignment (Tier 2)',
        slotId: 'pronunciation_scoring',
        tier: 2,
        requiresKey: true,
        defaultBaseUrl: 'https://api.groq.com/openai/v1',
        defaultModelOrVoice: 'whisper-large-v3-turbo',
        modelSuggestions: ['whisper-large-v3-turbo', 'whisper-large-v3', 'distil-whisper-large-v3-en'],
        modelFieldLabel: 'Whisper Model (e.g. whisper-large-v3-turbo or whisper-1)',
        baseUrlPlaceholder: 'https://api.groq.com/openai/v1 or https://api.openai.com/v1',
        description: 'Word-timestamp STT aligned to reference text to score word accuracy & timing.'
      },
      {
        id: 'gemini_pronunciation',
        name: 'Google Gemini Audio Recognition (Tier 2)',
        slotId: 'pronunciation_scoring',
        tier: 2,
        requiresKey: true,
        defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        defaultModelOrVoice: 'gemini-3.5-transcribe',
        modelSuggestions: ['gemini-3.5-transcribe', 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'],
        modelFieldLabel: 'Gemini Model (audio input)',
        baseUrlPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
        description: 'Shadowing audio recognition with Gemini 3.5 word-level timestamps for alignment. For phoneme-level assessment, use Azure Pronunciation Assessment.'
      },
      {
        id: 'custom_openai_pronunciation',
        name: 'Custom (OpenAI-compatible) STT Alignment (Tier 2)',
        slotId: 'pronunciation_scoring',
        tier: 2,
        requiresKey: true,
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultModelOrVoice: 'whisper-1',
        modelSuggestions: ['whisper-1', 'whisper-large-v3-turbo', 'whisper-large-v3'],
        modelFieldLabel: 'Model Name (e.g. whisper-1)',
        baseUrlPlaceholder: 'https://your-custom-stt-gateway.com/v1',
        description: 'Custom OpenAI-compatible /audio/transcriptions endpoint with free-text model and selectable auth.'
      },
      {
        id: 'offline_pronunciation',
        name: 'On-Device Offline Recognizer + Alignment (Tier 3)',
        slotId: 'pronunciation_scoring',
        tier: 3,
        requiresKey: false,
        defaultBaseUrl: 'offline://android-speech-recognizer',
        defaultModelOrVoice: 'android-offline',
        modelSuggestions: ['android-offline'],
        modelFieldLabel: 'Offline recognizer (android-offline)',
        baseUrlPlaceholder: 'offline://android-speech-recognizer',
        description: 'Android system speech recognition with approximate word alignment; no Vosk model is bundled and individual phonemes are not assessed.'
      }
    ]
  },
  ielts_stt: {
    id: 'ielts_stt',
    number: 3,
    title: '3. Speech-to-Text for IELTS Answers',
    subtitle: 'Transcribes IELTS answers into text; no word-level pronunciation scoring',
    providers: [
      {
        id: 'whisper_stt',
        name: 'Whisper-Compatible STT (Tier 2)',
        slotId: 'ielts_stt',
        tier: 2,
        requiresKey: true,
        defaultBaseUrl: 'https://api.groq.com/openai/v1',
        defaultModelOrVoice: 'whisper-large-v3-turbo',
        modelSuggestions: ['whisper-large-v3-turbo', 'whisper-large-v3', 'distil-whisper-large-v3-en'],
        modelFieldLabel: 'Whisper Model (whisper-large-v3-turbo or whisper-1)',
        baseUrlPlaceholder: 'https://api.groq.com/openai/v1 or https://api.openai.com/v1',
        description: 'Online Whisper transcription for IELTS answer text; pronunciation timing is not used here.'
      },
      {
        id: 'gemini_stt',
        name: 'Google Gemini Speech-to-Text (Tier 2)',
        slotId: 'ielts_stt',
        tier: 2,
        requiresKey: true,
        defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        defaultModelOrVoice: 'gemini-3.5-transcribe',
        modelSuggestions: ['gemini-3.5-transcribe', 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'],
        modelFieldLabel: 'Gemini transcription model (e.g. gemini-3.5-transcribe)',
        baseUrlPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
        description: 'Gemini audio transcription using inline WAV input; preserves spoken wording for IELTS analysis.'
      },
      {
        id: 'custom_openai_stt',
        name: 'Custom (OpenAI-compatible) STT (Tier 2)',
        slotId: 'ielts_stt',
        tier: 2,
        requiresKey: true,
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultModelOrVoice: 'whisper-1',
        modelSuggestions: ['whisper-1', 'whisper-large-v3-turbo', 'whisper-large-v3'],
        modelFieldLabel: 'Model Name (e.g. whisper-1)',
        baseUrlPlaceholder: 'https://your-custom-stt-gateway.com/v1',
        description: 'Custom OpenAI-compatible /audio/transcriptions endpoint with free-text model and selectable auth.'
      },
      {
        id: 'offline_stt',
        name: 'On-Device Offline Recognizer (Tier 3)',
        slotId: 'ielts_stt',
        tier: 3,
        requiresKey: false,
        defaultBaseUrl: 'offline://vosk-en-us',
        defaultModelOrVoice: 'vosk-model-small-en-us',
        modelSuggestions: ['vosk-model-small-en-us', 'android-offline'],
        modelFieldLabel: 'Offline Model (vosk-model-small-en-us)',
        baseUrlPlaceholder: 'offline://vosk-en-us',
        description: 'Built-in offline speech recognition for IELTS answer text.'
      }
    ]
  },
  llm_evaluator: {
    id: 'llm_evaluator',
    number: 4,
    title: '4. LLM Evaluator (IELTS Scoring & Feedback)',
    subtitle: 'Band 0–9 criteria scoring, sentence rewrites, and vocabulary upgrades',
    providers: [
      {
        id: 'openai_compat_eval',
        name: 'OpenAI-Compatible LLM (Tier 1)',
        slotId: 'llm_evaluator',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultModelOrVoice: 'gpt-4o-mini',
        modelSuggestions: ['gpt-4o-mini', 'gpt-4o', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'claude-3-5-haiku-20241022'],
        modelFieldLabel: 'Model Name (e.g. gpt-4o-mini, llama-3.3-70b-versatile)',
        baseUrlPlaceholder: 'https://api.openai.com/v1 (or Groq / OpenRouter / proxy URL)',
        description: 'Strict JSON IELTS rubric evaluation with automatic schema repair.'
      },
      {
        id: 'custom_openai_eval',
        name: 'Custom (OpenAI-compatible) LLM Evaluator (Tier 1)',
        slotId: 'llm_evaluator',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultModelOrVoice: 'gpt-4o-mini',
        modelSuggestions: ['gpt-4o-mini', 'gpt-4o', 'qwen-2.5-72b-instruct', 'deepseek-chat', 'mistral-large-latest'],
        modelFieldLabel: 'Free-Text Model Name',
        baseUrlPlaceholder: 'https://your-llm-gateway.example.com/v1',
        description: 'Custom OpenAI-compatible /chat/completions endpoint with free-text model and selectable auth.'
      },
      {
        id: 'gemini_eval',
        name: 'Google Gemini API (Tier 1)',
        slotId: 'llm_evaluator',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        defaultModelOrVoice: 'gemini-3.5-flash',
        modelSuggestions: ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'],
        modelFieldLabel: 'Gemini Model (e.g. gemini-3.5-flash, gemini-2.0-flash)',
        baseUrlPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
        description: 'Google Gemini structured JSON evaluation for IELTS Parts 1–3.'
      },
      {
        id: 'offline_rule_eval',
        name: 'Offline IELTS Evaluator (Unavailable — online API required)',
        slotId: 'llm_evaluator',
        tier: 3,
        requiresKey: false,
        defaultBaseUrl: 'offline://rule-evaluator',
        defaultModelOrVoice: 'heuristic-v1',
        modelSuggestions: ['heuristic-v1', 'heuristic-strict'],
        modelFieldLabel: 'Rule Engine Profile',
        baseUrlPlaceholder: 'offline://rule-evaluator',
        description: 'Unavailable: offline IELTS scoring is disabled. Connect and verify an online AI evaluator.'
      }
    ]
  },
  llm_generator: {
    id: 'llm_generator',
    number: 5,
    title: '5. LLM Generator (Questions & Sentences)',
    subtitle: 'AI-generated IELTS questions & shadowing practice sentences',
    providers: [
      {
        id: 'openai_compat_gen',
        name: 'OpenAI-Compatible Generator (Tier 1)',
        slotId: 'llm_generator',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultModelOrVoice: 'gpt-4o-mini',
        modelSuggestions: ['gpt-4o-mini', 'gpt-4o', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
        modelFieldLabel: 'Model Name (e.g. gpt-4o-mini, llama-3.3-70b-versatile)',
        baseUrlPlaceholder: 'https://api.openai.com/v1 (or Groq / OpenRouter / proxy URL)',
        description: 'Batch-generates new shadowing sentences & IELTS questions cached locally.'
      },
      {
        id: 'custom_openai_gen',
        name: 'Custom (OpenAI-compatible) Generator (Tier 1)',
        slotId: 'llm_generator',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultModelOrVoice: 'gpt-4o-mini',
        modelSuggestions: ['gpt-4o-mini', 'gpt-4o', 'qwen-2.5-72b-instruct', 'deepseek-chat', 'mistral-large-latest'],
        modelFieldLabel: 'Free-Text Model Name',
        baseUrlPlaceholder: 'https://your-llm-gateway.example.com/v1',
        description: 'Custom OpenAI-compatible /chat/completions endpoint with free-text model and selectable auth.'
      },
      {
        id: 'gemini_gen',
        name: 'Google Gemini Generator (Tier 1)',
        slotId: 'llm_generator',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        defaultModelOrVoice: 'gemini-3.5-flash-lite',
        modelSuggestions: ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'],
        modelFieldLabel: 'Gemini Model (e.g. gemini-3.5-flash-lite, gemini-2.0-flash)',
        baseUrlPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
        description: 'Batch-generates structured practice material via Google Gemini API.'
      },
      {
        id: 'offline_bank_gen',
        name: 'Offline Shadowing Sentence Library (Tier 3)',
        slotId: 'llm_generator',
        tier: 3,
        requiresKey: false,
        defaultBaseUrl: 'offline://builtin-bank',
        defaultModelOrVoice: 'builtin-v1',
        modelSuggestions: ['builtin-v1', 'curated-academic-v1'],
        modelFieldLabel: 'Offline Sentence Pack',
        baseUrlPlaceholder: 'offline://builtin-bank',
        description: 'Preloaded graded shadowing sentences only. IELTS question generation requires a tested Online AI provider.'
      }
    ]
  },
  llm_translation: {
    id: 'llm_translation',
    number: 6,
    title: '6. Translation & Grammar',
    subtitle: 'A separate AI connection for Shadowing translation and on-demand grammar explanations.',
    providers: [
      {
        id: 'openai_compat_translation',
        name: 'OpenAI-Compatible Translator (Tier 1)',
        slotId: 'llm_translation',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultModelOrVoice: 'gpt-4o-mini',
        modelSuggestions: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
        modelFieldLabel: 'Model Name',
        baseUrlPlaceholder: 'https://api.openai.com/v1 (or compatible gateway)',
        description: 'Independent OpenAI-compatible translation API for Shadowing.'
      },
      {
        id: 'custom_openai_translation',
        name: 'Custom (OpenAI-compatible) Translator (Tier 1)',
        slotId: 'llm_translation',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultModelOrVoice: 'gpt-4o-mini',
        modelSuggestions: ['gpt-4o-mini', 'gpt-4o', 'qwen-2.5-72b-instruct', 'deepseek-chat', 'mistral-large-latest'],
        modelFieldLabel: 'Free-text Model Name',
        baseUrlPlaceholder: 'https://your-translation-gateway.example.com/v1',
        description: 'Custom OpenAI-compatible /chat/completions endpoint with selectable authentication.'
      },
      {
        id: 'gemini_translation',
        name: 'Google Gemini Translator (Tier 1)',
        slotId: 'llm_translation',
        tier: 1,
        requiresKey: true,
        defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        defaultModelOrVoice: 'gemini-3.1-flash-lite',
        modelSuggestions: ['gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-pro-latest'],
        modelFieldLabel: 'Gemini Model',
        baseUrlPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
        description: 'Google Gemini translation API with plain-text responses.'
      },
      {
        id: 'offline_translation',
        name: 'Translation unavailable offline (Tier 3)',
        slotId: 'llm_translation',
        tier: 3,
        requiresKey: false,
        defaultBaseUrl: 'offline://translation-unavailable',
        defaultModelOrVoice: 'none',
        modelSuggestions: ['none'],
        modelFieldLabel: 'Offline translation',
        baseUrlPlaceholder: 'offline://translation-unavailable',
        description: 'No offline translation engine is bundled. Configure and verify an online translation API.'
      }
    ]
  }
};

export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

export function getPreset(slotId: SlotId, providerId: string): ProviderPreset {
  const slot = SLOT_DEFINITIONS[slotId];
  const found = slot.providers.find((p) => p.id === providerId);
  return found ?? slot.providers[slot.providers.length - 1];
}

export function getOfflinePreset(slotId: SlotId): ProviderPreset {
  const slot = SLOT_DEFINITIONS[slotId];
  const offline = slot.providers.find((p) => p.tier === 3);
  return offline ?? slot.providers[slot.providers.length - 1];
}

export function createDefaultSlotConfig(slotId: SlotId): SlotConfig {
  const defaultPreset = SLOT_DEFINITIONS[slotId].providers[0];
  return {
    slotId,
    providerId: defaultPreset.id,
    baseUrl: defaultPreset.defaultBaseUrl,
    modelOrVoice: defaultPreset.defaultModelOrVoice,
    speechRate: slotId === 'voice_tts' ? 1.0 : undefined,
    authStyle: 'bearer'
  };
}

export function createDefaultAllSlotsConfig(): AllSlotsConfig {
  return {
    voice_tts: createDefaultSlotConfig('voice_tts'),
    pronunciation_scoring: createDefaultSlotConfig('pronunciation_scoring'),
    ielts_stt: createDefaultSlotConfig('ielts_stt'),
    llm_evaluator: createDefaultSlotConfig('llm_evaluator'),
    llm_generator: createDefaultSlotConfig('llm_generator'),
    llm_translation: createDefaultSlotConfig('llm_translation')
  };
}
