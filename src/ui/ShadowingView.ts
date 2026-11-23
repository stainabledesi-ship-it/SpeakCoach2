import type { ShadowingDifficulty, ShadowingSentence } from '../data/shadowingBank';
import {
  appendShadowingSet,
  getActiveShadowingSet,
  moveShadowingSet,
  selectShadowingSentence,
  type ShadowingSetHistory
} from '../services/shadowingSetHistory';
import {
  audioRecorder,
  type RecognizerAlternative,
  type RecordedUtterance
} from '../services/audioRecorder';
import {
  scoreShadowingOfflineTier3,
  scoreShadowingTier2,
  type ShadowingScoreReport
} from '../services/shadowingScorer';
import { recordLastShadowingAttempt } from '../services/shadowingTelemetry';
import { loadAppSettings } from '../storage/appSettings';
import type { GlobalTierSummary } from '../services/tierManager';
import { clearPreloadedSentenceAudio, playAudioDataUrl, preloadSentenceAudio, speakSentenceWithTierFallback, stopAllTts } from '../services/ttsService';
import { activateShadowingAudioSet } from '../services/shadowingAudioStore';
import type { WordMatchStatus } from '../services/wordAlignment';
import { translateShadowingText } from '../services/translationService';
import { analyzeWavBase64Vad, type WavVadAnalysisResult } from '../services/wavVadAnalyzer';
import { transcribeWithTier2WhisperOrFallback } from '../services/whisperSttService';
import { getCachedModelWordTimings } from '../services/modelTimingService';
import { generateAiShadowingSentenceBatch } from '../services/shadowingAiGenerator';
import { ShadowingPrefetchScheduler, runShadowingPrefetchBatch } from '../services/shadowingPrefetch';
import { clearDiagnosticsCache } from './DiagnosticsView';
import { SHADOWING_LANGUAGES, getShadowingLanguage, countShadowingLanguageUnits, type ShadowingLanguageCode } from '../data/shadowingLanguages';
import { loadShadowingLanguageHistories, saveShadowingLanguageHistories, getShadowingHistoryForLanguage, createShadowingHistoryForLanguage, setShadowingHistoryForLanguage, loadSelectedShadowingLanguage, saveSelectedShadowingLanguage, type ShadowingLanguageHistories } from '../services/shadowingLanguageHistory';

interface ShadowingState {
  difficulty: ShadowingDifficulty;
  languageCode: ShadowingLanguageCode;
  topicInput: string;
  isGeneratingAi: boolean;
  aiGenerationError: string | null;
  index: number;
  customDrillText: string | null;
  drillWords: string[];
  drillPreviousStatuses: Record<string, { status: WordMatchStatus; accuracyScore: number }>;
  recognizedTranscript: string;
  recognizedConfidence: number;
  recognizedAlternatives: RecognizerAlternative[];
  recognizerError?: string;
  emptyAttemptError: string | null;
  lastRecording: RecordedUtterance | null;
  lastReport: ShadowingScoreReport | null;
  statusMessage: string;
  navigationNotice: string | null;
  activeModelPlayback: 'normal' | 'slow' | null;
  audioActivity: 'idle' | 'playingModel(normal)' | 'playingModel(slow)' | 'playingWord' | 'playingMine(normal)' | 'playingMine(slow)' | 'recording' | 'stopping/scoring';
  translationText: string;
  translationSourceText: string | null;
  translationTargetLanguage: string;
  translationResult: string;
  grammarResult: string;
  translationMode: 'translate' | 'grammar';
  translationStatus: string | null;
  translationStatusType: 'info' | 'pass' | 'fail';
  isTranslating: boolean;
  forceSpeechApiNotice: boolean;
}

const state: ShadowingState = {
  difficulty: 'easy',
  languageCode: 'en',
  topicInput: '',
  isGeneratingAi: false,
  aiGenerationError: null,
  index: 0,
  customDrillText: null,
  drillWords: [],
  drillPreviousStatuses: {},
  recognizedTranscript: '',
  recognizedConfidence: 0,
  recognizedAlternatives: [],
  recognizerError: undefined,
  emptyAttemptError: null,
  lastRecording: null,
  lastReport: null,
  statusMessage: 'Tap "Play Model 1.0x" to listen, then "Record Repetition" to repeat aloud.',
  navigationNotice: null,
  activeModelPlayback: null,
  audioActivity: 'idle',
  translationText: '',
  translationSourceText: null,
  translationTargetLanguage: 'fa',
  translationResult: '',
  grammarResult: '',
  translationMode: 'translate',
  translationStatus: null,
  translationStatusType: 'info',
  isTranslating: false,
  forceSpeechApiNotice: false
};

const TRANSLATION_LANGUAGES = [
  { code: 'fa', label: 'Persian (فارسی)' },
  { code: 'ar', label: 'Arabic (العربية)' },
  { code: 'de', label: 'German (Deutsch)' },
  { code: 'es', label: 'Spanish (Español)' },
  { code: 'fr', label: 'French (Français)' },
  { code: 'it', label: 'Italian (Italiano)' },
  { code: 'nl', label: 'Dutch (Nederlands)' },
  { code: 'pt', label: 'Portuguese (Português)' },
  { code: 'ru', label: 'Russian (Русский)' },
  { code: 'sv', label: 'Swedish (Svenska)' },
  { code: 'tr', label: 'Turkish (Türkçe)' },
  { code: 'zh', label: 'Chinese (简体中文)' },
  { code: 'ja', label: 'Japanese (日本語)' },
  { code: 'ko', label: 'Korean (한국어)' }
];

function renderTranslationLanguageOptions(selected: string): string {
  return TRANSLATION_LANGUAGES.map(language =>
    `<option value="${language.code}" ${language.code === selected ? 'selected' : ''}>${escapeHtml(language.label)}</option>`
  ).join('');
}

let sentenceSetHistory: ShadowingSetHistory | null = null;
let sentenceSetHistoryPromise: Promise<ShadowingSetHistory> | null = null;
let sentenceLanguageHistories: ShadowingLanguageHistories = {};
const SPEECH_API_NOTICE_DISMISSED_KEY = 'speakcoach_speech_api_notice_dismissed_v1';
function isSpeechApiNoticeDismissed(): boolean {
  try { return localStorage.getItem(SPEECH_API_NOTICE_DISMISSED_KEY) === 'true'; }
  catch { return false; }
}
function isSpeechApiRelatedError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? '')).replace(/[_-]+/g, ' ');
  return /\b(api|http|status|401|403|404|408|409|429|5\d\d|network|fetch|timeout|endpoint|provider|model|unsupported|not supported|quota|rate.?limit|connection|service unavailable|cors|recognition service)\b/i.test(message);
}
function reopenSpeechApiNoticeForError(error: unknown): void {
  if (isSpeechApiRelatedError(error)) state.forceSpeechApiNotice = true;
}
async function persistCurrentShadowingHistory(): Promise<void> {
  if (!sentenceSetHistory) return;
  sentenceLanguageHistories = setShadowingHistoryForLanguage(sentenceLanguageHistories, state.languageCode, sentenceSetHistory);
  await saveShadowingLanguageHistories(sentenceLanguageHistories);
}
function ensureSentenceSetHistory(): Promise<ShadowingSetHistory> {
  if (!sentenceSetHistoryPromise) sentenceSetHistoryPromise = (async () => {
    sentenceLanguageHistories = await loadShadowingLanguageHistories();
    state.languageCode = await loadSelectedShadowingLanguage();
    const existing = getShadowingHistoryForLanguage(sentenceLanguageHistories, state.languageCode);
    sentenceSetHistory = existing ?? createShadowingHistoryForLanguage(state.languageCode);
    if (!existing) await persistCurrentShadowingHistory();
    return sentenceSetHistory;
  })();
  return sentenceSetHistoryPromise;
}

let shadowingRecordingTimeout: ReturnType<typeof setTimeout> | null = null;
let shadowingModelPlaybackToken = 0;
let shadowingIsStopping = false;
let shadowingPrefetchWindowKey = '';
let shadowingActiveAudioSetId: string | null = null;
let shadowingPrefetchEpoch = 0;
let shadowingTier3FallbackNoticeShown = false;
const shadowingPrefetchScheduler = new ShadowingPrefetchScheduler();
let shadowingPrefetchQueue: Promise<void> = Promise.resolve();
let shadowingViewGeneration = 0;

function clearShadowingRecordingTimer(): void {
  if (shadowingRecordingTimeout) clearTimeout(shadowingRecordingTimeout);
  shadowingRecordingTimeout = null;
}

function isAudioCaptureBusy(): boolean {
  return audioRecorder.isRecording() || shadowingIsStopping || state.audioActivity === 'recording' || state.audioActivity === 'stopping/scoring';
}
function isAudioPlaybackActive(): boolean {
  return state.audioActivity.startsWith('playing');
}
function setShadowingCaptureControlsDisabled(container: HTMLElement, disabled: boolean): void {
  container.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select').forEach(control => {
    if (control.id === 'sh-stop-score-btn') return;
    control.disabled = disabled;
    control.setAttribute('aria-disabled', String(disabled));
  });
}

function clearAttemptState(): void {
  clearShadowingRecordingTimer();
  state.navigationNotice = null;
  state.recognizedTranscript = '';
  state.recognizedConfidence = 0;
  state.recognizedAlternatives = [];
  state.recognizerError = undefined;
  state.emptyAttemptError = null;
  state.lastRecording = null;
  state.lastReport = null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderVadWaveformSection(vad?: WavVadAnalysisResult): string {
  if (!vad || vad.waveformBins.length === 0) return '';

  const barsHtml = vad.waveformBins
    .map((b) => {
      const hPct = Math.max(12, Math.round(b.amplitude * 100));
      return `<div class="vad-bar ${b.state}" data-vad-state="${b.state}" style="height: ${hPct}%" title="${b.startMs}-${b.endMs}ms (${b.state})"></div>`;
    })
    .join('');

  const pausesText =
    vad.midSentencePauses.length > 0
      ? vad.midSentencePauses
          .map((p, idx) => `#${idx + 1}: ${p.durationMs} ms (@${p.startMs}–${p.endMs} ms)`)
          .join(' · ')
      : 'None detected';

  return `
    <div class="vad-box" id="sh-vad-summary">
      <div class="card-header vad-report-header">
        <span class="slot-summary-title"><svg class="sh-inline-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h3l2-6 4 12 3-9 2 3h4"/></svg> Waveform &amp; Voice Activity (Approximate)</span>
        <span class="tier-badge offline">Approximate VAD</span>
      </div>
      <div class="card-subtitle" id="sh-vad-metrics">
        Speech: <strong>${vad.speechDurationMs} ms</strong> (Expected: ${vad.expectedDurationMs} ms · Rate: ${Math.round(
          vad.speakingRateRatio * 100
        )}% ${vad.speakingRateLabel}) ·
        Leading Silence: <strong>${vad.leadingSilenceMs} ms</strong> ·
        Trailing Silence: <strong>${vad.trailingSilenceMs} ms</strong>
      </div>
      <div class="card-subtitle vad-pauses" id="sh-vad-pauses">
        Mid-Sentence Pauses (${vad.midSentencePauses.length}): <strong>${pausesText}</strong>
      </div>
      <div class="vad-waveform" id="sh-vad-waveform">
        ${barsHtml}
      </div>
      <div class="card-subtitle vad-legend">
        Legend: <span class="vad-legend-speech">■ Speech</span> ·
        <span class="vad-legend-pause">■ Pause Marker</span> ·
        <span class="vad-legend-silence">■ Leading/Trailing Silence</span>
      </div>
    </div>
  `;
}

function renderReportHtml(report: ShadowingScoreReport, hasRecording: boolean, drillMode = false, previousStatuses: Record<string, { status: WordMatchStatus; accuracyScore: number }> = {}, audioBusy = false, playbackActive = false, wordPlayback = false, weakActionHtml = ''): string {
  const isOfflineMode = report.activeTier.tier === 3 || report.activeTier.label === 'Basic offline';

  const chipsHtml = report.words
    .map((w) => {
      const text =
        w.status === 'extra' ? `+${w.spokenWord}` : w.referenceWord ?? w.spokenWord ?? '';
      const statusMark = w.status === 'match' ? '✓' : w.status === 'mispronounced' ? '!' : w.status === 'missing' ? '−' : '+';
      const speedBadge =
        !drillMode && !isOfflineMode && w.speedLabel
          ? `<span class="speed-tag ${w.speedLabel.replace(' ', '-')}">${w.speedLabel}</span>`
          : '';
      const durationText = !drillMode && !isOfflineMode && w.spokenDurationMs ? ` · ${w.spokenDurationMs}ms` : '';
      const previous = w.referenceWord ? previousStatuses[w.referenceWord] : undefined;
      const rank: Record<WordMatchStatus, number> = { missing: 0, mispronounced: 1, match: 2, extra: -1 };
      const currentQuality = rank[w.status] * 100 + w.accuracyScore;
      const previousQuality = previous ? rank[previous.status] * 100 + previous.accuracyScore : 0;
      const progress = drillMode && previous ? (currentQuality > previousQuality + 5 ? 'Improved' : currentQuality < previousQuality - 5 ? 'Needs work' : 'No change') : '';
      const meta =
        w.status === 'missing'
          ? 'missing'
          : w.status === 'extra'
            ? `extra${durationText}`
            : `${w.accuracyScore}%${durationText}`;
      const replayText = (w.referenceWord ?? w.spokenWord ?? '').trim();
      return `
        <button type="button" class="word-chip ${w.status}" data-word-status="${w.status}" data-word-replay="${escapeHtml(replayText)}" aria-label="Play pronunciation of ${escapeHtml(replayText)}" ${replayText && !audioBusy && (!playbackActive || wordPlayback) ? '' : 'disabled'}>
          <span class="word-chip-status" aria-hidden="true">${statusMark}</span>
          <span>${escapeHtml(text)}</span>
          ${speedBadge}
          <span class="word-chip-meta">${meta}</span>${progress ? `<span class="drill-word-progress">${progress}</span>` : ""}
        </button>
      `;
    })
    .join('');

  const timingSectionHtml = isOfflineMode
    ? `<div class="status-box info sh-offline-timing-disabled" id="sh-offline-timing-disabled">
         <svg class="sh-inline-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></svg> <strong>Word timing &amp; recording replay disabled in System SpeechRecognizer mode:</strong> Android's system SpeechRecognizer returns transcript text only to SpeakCoach in this mode; the OS recognition service controls audio processing and may require network access. Configure an online Whisper STT slot for recording replay and per-word timing.
       </div>`
    : `<div class="timing-bars-list" id="sh-timing-bars">
         ${report.words
           .filter((w) => w.referenceWord)
           .map((w) => {
             const exp = w.expectedDurationMs ?? 300;
             const spk = w.spokenDurationMs ?? 0;
             const ratioPct = Math.min(220, Math.round((spk / Math.max(100, exp)) * 100));
             const barWidth = Math.min(100, Math.round((ratioPct / 180) * 100));
             const speedClass = w.speedLabel ? w.speedLabel.replace(' ', '-') : 'ok';
             const speedText = w.speedLabel ? ` · Speed: ${w.speedLabel}` : '';
             const spokenTimes =
               w.spokenStartMs !== undefined
                 ? `Spoken: ${w.spokenStartMs}–${w.spokenEndMs ?? (w.spokenStartMs + spk)} ms (${spk} ms)`
                 : `Spoken: ${spk} ms`;
             const modelTimes = `Ref: ${w.expectedStartMs ?? 0}–${w.expectedEndMs ?? ((w.expectedStartMs ?? 0) + exp)} ms (${exp} ms)`;

             return `
               <div class="timing-row">
                 <div class="timing-row-head">
                   <span>
                     <strong>${escapeHtml(w.referenceWord ?? '')}</strong> (${w.status})
                     ${w.speedLabel ? `<span class="speed-pill ${speedClass}">${w.speedLabel}</span>` : ''}
                   </span>
                   <span>${spokenTimes} vs ${modelTimes} (${ratioPct}%)${speedText}</span>
                 </div>
                 <div class="timing-track">
                   <div class="timing-fill ${speedClass}" style="width: ${barWidth}%"></div>
                 </div>
               </div>
             `;
           })
           .join('')}
       </div>`;

  const replayRecBtn = hasRecording
    ? `<button type="button" class="btn btn-secondary" id="sh-replay-my-audio-btn" ${audioBusy || (playbackActive && state.audioActivity !== 'playingMine(normal)') ? 'disabled' : ''}>
         <svg class="sh-inline-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg> Replay My Recording
       </button>
       <button type="button" class="btn btn-secondary" id="sh-replay-my-slow-btn" ${audioBusy || (playbackActive && state.audioActivity !== 'playingMine(slow)') ? 'disabled' : ''}>
         <svg class="sh-inline-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg> My Recording Slow (0.75x)
       </button>`
    : `<button type="button" class="btn btn-secondary" id="sh-replay-my-audio-btn" disabled title="No audio kept in System SpeechRecognizer mode">
         <svg class="sh-inline-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6l-5 4H4Zm13-1 4 6m0-6-4 6"/></svg> Replay My Recording (Disabled in Offline Mode)
       </button>`;

  return `
    <div id="sh-score-card" class="sh-score-card">
      <div class="sh-score-heading section-heading">
        <div>
          <h2 class="card-title">Shadowing Score Report</h2>
          <p class="card-subtitle">
            Scored via <strong>${escapeHtml(report.activeTier.detailLabel)}</strong> · Overall Pace: <strong>${Math.round(
              report.overallPaceRatio * 100
            )}% (${report.overallPaceLabel})</strong>
          </p>
        </div>
        <span class="tier-badge ${report.activeTier.label === 'Online AI' ? 'online' : 'offline'}">
          <span class="tier-dot"></span>
          ${report.activeTier.label}
        </span>
      </div>

      ${
        report.approximateNotice
          ? `<div class="status-box info" id="sh-tier3-notice">${escapeHtml(report.approximateNotice)}</div>`
          : ''
      }

      <div class="score-metrics-grid ${drillMode ? 'sh-drill-metrics' : ''}">
        ${drillMode ? `
          <div class="metric-tile metric-tile-overall">
            <div class="metric-value" id="sh-pron-score">${report.pronunciationScore}</div>
            <div class="metric-label">Word match</div>
          </div>
        ` : `
          <div class="metric-tile metric-tile-overall"><div class="metric-value" id="sh-overall-score">${report.overallScore}</div><div class="metric-label">Overall score</div></div>
          <div class="metric-tile"><div class="metric-value" id="sh-pron-score">${report.pronunciationScore}</div><div class="metric-label">${report.activeTier.tier >= 2 ? 'Word match' : 'Pronunciation assessment'}</div></div>
          <div class="metric-tile"><div class="metric-value" id="sh-fluency-score">${report.fluencyScore}</div><div class="metric-label">Fluency</div></div>
          <div class="metric-tile"><div class="metric-value" id="sh-pace-score">${report.paceScore}</div><div class="metric-label">Pace (${report.overallPaceLabel})</div></div>
          <div class="metric-tile"><div class="metric-value" id="sh-complete-score">${report.completenessScore}%</div><div class="metric-label">Completeness</div></div>
        `}
      </div>

      <p class="word-replay-help" id="sh-word-replay-help">Tap any word below to hear its pronunciation separately.</p>
      <div class="word-tokens-wrap" id="sh-word-chips">
        ${chipsHtml}
      </div>
      ${weakActionHtml}

      <div class="btn-row sh-report-playback-actions">
        ${replayRecBtn}
      </div>

      ${drillMode ? '' : `<details class="sh-timing-details">
            <summary>Details · Timing &amp; voice activity</summary>
            ${renderVadWaveformSection(report.vadAnalysis)}
            ${timingSectionHtml}
          </details>`}
    </div>
  `;
}

export function renderShadowingView(
  container: HTMLElement,
  summary: GlobalTierSummary
): () => void {
  const viewGeneration = ++shadowingViewGeneration;
  if (!sentenceSetHistory) {
    container.innerHTML = '<div class="shadowing-page shadowing-main-card"><p class="card-subtitle" role="status">Preparing your offline sentence library…</p></div>';
    void ensureSentenceSetHistory().then(history => {
      sentenceSetHistory = history;
      if (viewGeneration === shadowingViewGeneration) renderShadowingView(container, summary);
    }).catch(error => {
      if (viewGeneration !== shadowingViewGeneration) return;
      sentenceSetHistoryPromise = null;
      container.innerHTML = '<div class="shadowing-page shadowing-main-card"><div class="status-box fail" role="alert">Could not load the sentence library. Please restart the app and try again.</div></div>';
      console.error('[SpeakCoach] Shadowing history initialization failed.', error);
    });
    return () => { shadowingViewGeneration++; stopAllTts(); shadowingPrefetchWindowKey = ''; shadowingPrefetchScheduler.reset(); };
  }
  const activeHistory = sentenceSetHistory[state.difficulty];
  const activeSet = activeHistory.sets.length ? getActiveShadowingSet(sentenceSetHistory, state.difficulty) : undefined;
  state.index = activeHistory.activeSentenceIndex;
  const sentence: ShadowingSentence | undefined = activeSet?.sentences[state.index];
  const hasSentence = !!sentence;
  const targetText = state.customDrillText ?? sentence?.text ?? '';
  const translationSource = state.customDrillText ?? sentence?.text ?? '';
  if (state.translationSourceText !== translationSource) {
    state.translationSourceText = translationSource;
    state.translationText = translationSource;
    state.translationResult = '';
    state.grammarResult = '';
    state.translationStatus = null;
    state.translationStatusType = 'info';
  }
  const targetExpectedDurationMs = state.customDrillText
    ? Math.max(1200, countShadowingLanguageUnits(state.customDrillText, state.languageCode) * 480)
    : sentence?.expectedTotalDurationMs ?? 3500;
  const selectedLanguage = getShadowingLanguage(state.languageCode);
  const activeAudioSetId = activeSet ? `${state.languageCode}:${state.difficulty}:${activeSet.id}` : null;
  const audioSetContextPromise = activeAudioSetId
    ? activateShadowingAudioSet(activeAudioSetId, { createdAt: activeSet?.createdAt }).then(generation => ({ setId: activeAudioSetId, generation }))
    : Promise.resolve(null);
  // Stable identity is the persisted sentence-set ID, not view lifecycle or the first sentence.
  const prefetchWindowKey = `${activeAudioSetId ?? 'none'}:${state.customDrillText ?? ''}`;
  if (activeAudioSetId !== shadowingActiveAudioSetId) {
    shadowingActiveAudioSetId = activeAudioSetId;
    clearPreloadedSentenceAudio(); // Clear RAM-only entries only on a real active-set change.
  }
  if (prefetchWindowKey !== shadowingPrefetchWindowKey) {
    shadowingPrefetchWindowKey = prefetchWindowKey;
    shadowingPrefetchEpoch++;
    shadowingPrefetchScheduler.reset(0);
  }
  const enqueueShadowingPrefetch = (indices: number[]): void => {
    if (!activeSet || !indices.length) return;
    const queue = indices.map(index => activeSet.sentences[index]).filter((item): item is ShadowingSentence => Boolean(item));
    if (!queue.length) return;
    const queuedEpoch = shadowingPrefetchEpoch;
    shadowingPrefetchQueue = shadowingPrefetchQueue.then(async () => {
      if (queuedEpoch !== shadowingPrefetchEpoch) return;
      const context = await audioSetContextPromise;
      if (!context) return;
      const completed = await runShadowingPrefetchBatch(queue, async (item) => {
        if (queuedEpoch !== shadowingPrefetchEpoch) return false;
        const settings = await loadAppSettings();
        if (!settings.prefetchShadowingAudio) return false;
        return preloadSentenceAudio(item.text, {
          locale: selectedLanguage.locale,
          shadowingSetAudio: { ...context, kind: 'sentence' }
        });
      });
      if (queuedEpoch !== shadowingPrefetchEpoch) return;
      shadowingPrefetchScheduler.completeBatch(completed);
      // If the learner crossed the next position threshold while this serial
      // batch was running, release the next window now instead of waiting for
      // another practice score or user action.
      if (completed === queue.length && queuedEpoch === shadowingPrefetchEpoch) {
        const followUp = shadowingPrefetchScheduler.reachPosition(state.index, activeSet.sentences.length);
        if (followUp.length) enqueueShadowingPrefetch(followUp);
      }
    });
  };
  const startShadowingPrefetch = (): void => {
    if (!activeSet || state.customDrillText) return;
    void loadAppSettings().then(settings => {
      if (prefetchWindowKey !== shadowingPrefetchWindowKey || !settings.prefetchShadowingAudio) return;
      enqueueShadowingPrefetch(shadowingPrefetchScheduler.reachPosition(state.index, activeSet.sentences.length));
    }).catch(() => {
      // Fail closed: do not spend provider quota when the preference cannot be read.
    });
  };
  // The navigation belongs to the same app root as this view. Avoid a global
  // lookup, which can update another mounted app instance (or a stale test root).
  const ieltsNavButton = container.parentElement?.querySelector<HTMLButtonElement>('#nav-ielts') ?? null;
  if (ieltsNavButton) {
    // IELTS remains available regardless of the selected Shadowing language.
    ieltsNavButton.disabled = false;
    ieltsNavButton.title = 'IELTS practice';
    ieltsNavButton.removeAttribute('aria-disabled');
  }

  const isRec = audioRecorder.isRecording();
  const isStopping = shadowingIsStopping;
  const isCaptureBusy = isAudioCaptureBusy();
  const isPlaybackActive = isAudioPlaybackActive();
  const isWordPlayback = state.audioActivity === 'playingWord';
  const scoringTier = summary.slots.pronunciation_scoring;
  const ttsTier = summary.slots.voice_tts;
  const hasLanguageSentenceSet = activeHistory.sets.length > 0;

  const altsHtml =
    state.recognizedAlternatives.length > 0
      ? state.recognizedAlternatives
          .map((a) => `"${escapeHtml(a.transcript)}" (${Math.round(a.confidence * 100)}%)`)
          .join(' · ')
      : state.recognizedTranscript
        ? `"${escapeHtml(state.recognizedTranscript)}" (${Math.round(
            state.recognizedConfidence * 100
          )}%)`
        : 'None yet (starts empty on every attempt)';

  const drillMode = Boolean(state.customDrillText);
  const drillWords = state.lastReport?.words.filter(word => word.referenceWord) ?? [];
  const drillCorrect = drillWords.filter(word => word.status === 'match').length;
  const weakReferenceWords = [...new Set(state.lastReport?.words.filter(word => word.referenceWord && word.status !== 'match').map(word => word.referenceWord!) ?? [])];
  const remainingDrillWords = [...new Set(drillWords.filter(word => word.status !== 'match').map(word => word.referenceWord!).filter(Boolean))];
  const weakActionHtml = state.lastReport ? (drillMode
    ? remainingDrillWords.length
      ? `<div class="sh-retry-weak-actions"><button type="button" class="btn btn-primary" id="sh-retry-weak-btn" ${isCaptureBusy || isPlaybackActive ? 'disabled' : ''}><span>Retry remaining weak words</span> (<span>${remainingDrillWords.length}</span>)</button></div>`
      : '<p class="sh-drill-success" role="status">All target words matched.</p>'
    : weakReferenceWords.length
      ? `<div class="sh-retry-weak-actions"><button type="button" class="btn btn-primary" id="sh-retry-weak-btn" ${isCaptureBusy || isPlaybackActive ? 'disabled' : ''}><span>${weakReferenceWords.length === 1 ? 'Practice weak word' : 'Retry weak words'}</span> ${weakReferenceWords.length === 1 ? '' : `(<span>${weakReferenceWords.length}</span>)`}</button></div>`
      : '') : '';
  const resultStripHtml = '';
  /* The score report is the single result surface; weak-word retry is rendered inside it. */
  container.innerHTML = `
    <div class="shadowing-page shadowing-main-card">
      <div class="page-heading shadowing-main-header">
        <div class="page-heading-title">
          <h1 class="card-title shadowing-page-title"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v3m-4 0h8"/></svg>Shadowing Trainer</h1>
        </div>
        <button type="button" class="btn btn-secondary sh-api-notice-toggle" aria-label="Speech help" title="Speech help" id="sh-api-notice-toggle-btn" aria-controls="sh-api-capability-notice">?</button>
        <span class="tier-badge sh-scoring-status ${scoringTier.label === 'Online AI' ? 'online' : 'offline'}">
          <span class="tier-dot"></span>
          ${scoringTier.label}
        </span>
      </div>
      ${ttsTier.reason ? `<p class="sh-provider-notice" role="status">Voice: <strong>${escapeHtml(ttsTier.label)}</strong> · ${escapeHtml(ttsTier.reason)}</p>` : ''}
      <details class="sh-context-sheet">
        <summary class="sh-context-summary"><span class="sh-context-values">${escapeHtml(selectedLanguage.nativeName)} · ${state.difficulty[0].toUpperCase()+state.difficulty.slice(1)} · ${activeSet ? activeHistory.sets.findIndex(set => set.id === activeSet.id)+1 : 0} / ${activeHistory.sets.length}</span><span class="sh-context-action">Change</span></summary>
      <div class="sh-language-picker-field">
        <label class="sh-language-picker-label" for="sh-language-select">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>
          <span>Practice language</span>
        </label>
        <select class="form-select sh-language-select" id="sh-language-select" aria-label="Shadowing practice language" ${isCaptureBusy || state.isGeneratingAi ? "disabled" : ""}>
          ${SHADOWING_LANGUAGES.map(language => `<option value="${language.code}" ${language.code === state.languageCode ? 'selected' : ''}>${escapeHtml(language.nativeName)} — ${escapeHtml(language.label)}</option>`).join('')}
        </select>
      </div>
      <section class="sh-sentence-set-details" aria-labelledby="sh-sentence-set-title">
        <div class="sh-sentence-set-heading section-heading"><h2 id="sh-sentence-set-title">Sentence set</h2><span class="sh-sentence-set-summary">${state.difficulty[0].toUpperCase()+state.difficulty.slice(1)} · Set ${activeSet ? activeHistory.sets.findIndex(set => set.id === activeSet.id)+1 : 0} of ${activeHistory.sets.length} · Change${state.isGeneratingAi ? " · Generating…" : state.aiGenerationError ? " · Error" : ""}</span></div>
      <p class="sh-set-guidance">AI-generated sets contain 20 sentences; offline starter sets may contain one.</p>
      <div class="pill-tabs shadowing-difficulty-tabs" aria-label="Sentence difficulty">
        <button type="button" class="pill-btn ${state.difficulty === 'easy' ? 'active' : ''}" data-diff="easy" aria-pressed="${state.difficulty === 'easy'}" ${isRec || isStopping ? 'disabled' : ''}>Easy</button>
        <button type="button" class="pill-btn ${state.difficulty === 'medium' ? 'active' : ''}" data-diff="medium" aria-pressed="${state.difficulty === 'medium'}" ${isRec || isStopping ? 'disabled' : ''}>Medium</button>
        <button type="button" class="pill-btn ${state.difficulty === 'hard' ? 'active' : ''}" data-diff="hard" aria-pressed="${state.difficulty === 'hard'}" ${isRec || isStopping ? 'disabled' : ''}>Hard</button>
      </div>

      <div class="sh-sentence-set-controls">
        <div class="form-field sh-topic-field">
          <label class="form-label" for="sh-topic-input">Optional topic</label>
          <input type="text" class="form-input sh-topic-input" id="sh-topic-input" maxlength="100" placeholder="Leave blank for a mix of topics." value="${escapeHtml(state.topicInput)}" />
        </div>
        <div class="btn-row sh-generate-actions">
          <button type="button" class="btn ${hasLanguageSentenceSet ? 'btn-secondary' : 'btn-primary'}" id="sh-generate-ai-btn" ${state.isGeneratingAi || isRec || isStopping ? 'disabled' : ''}>
            ${state.isGeneratingAi ? 'Generating sentence set…' : 'Get new sentence set'}
          </button>
        </div>
        <div class="sh-history-controls" aria-label="Sentence set history">
          <span class="sh-history-caption">From history</span>
          <span id="sh-history-position" class="card-subtitle sh-history-position">Set ${activeSet ? activeHistory.sets.findIndex(set => set.id === activeSet.id) + 1 : 0} of ${activeHistory.sets.length}</span>
          <div class="sh-history-arrows">
            <button type="button" class="btn btn-secondary sh-history-arrow" id="sh-history-prev-btn" aria-label="Older sentence set" title="Older sentence set" ${isRec || isStopping ? 'disabled' : ''} ${!activeSet || activeHistory.sets.findIndex(set => set.id === activeSet.id) <= 0 ? 'disabled' : ''}>←</button>
            <button type="button" class="btn btn-secondary sh-history-arrow" id="sh-history-next-btn" aria-label="Newer sentence set" title="Newer sentence set" ${isRec || isStopping ? 'disabled' : ''} ${!activeSet || activeHistory.sets.findIndex(set => set.id === activeSet.id) >= activeHistory.sets.length - 1 ? 'disabled' : ''}>→</button>
          </div>
        </div>
        
        ${state.aiGenerationError ? `<div class="status-box fail ai-generation-error" id="sh-ai-generation-error" role="alert">${escapeHtml(state.aiGenerationError)}</div>` : ''}
      </div>
      </section>
      </details>

      
      ${!hasLanguageSentenceSet ? `<div class="status-box info sh-empty-language-history" role="status">There are no saved ${escapeHtml(selectedLanguage.label)} sentences yet. Generate a sentence set in this language to begin. Your English sentence history remains separate. <button type="button" class="btn btn-primary" id="sh-empty-generate-btn">Generate now</button></div>` : ''}

      ${scoringTier.tier === 3 ? `<details class="offline-quality-notice shadowing-offline-notice" aria-label="Offline pronunciation accuracy notice">
        <summary><strong>Pronunciation accuracy notice</strong><span class="offline-quality-learn-more">Learn more</span></summary>
        <p>Offline feedback uses the device or browser speech recognizer and approximate word/timing checks. It is still useful for practising repetition, fluency and matching the target sentence, but it is not a precise pronunciation score. For more dependable transcription and word-level timing, connect and test an online speech-to-text provider in Slot 2 (for example, Groq Whisper when available for your account). This improves the information available to the practice feedback, but true phoneme-level pronunciation assessment requires a dedicated pronunciation-assessment service.</p>
      </details>` : ''}


      <p class="card-subtitle sh-ai-sentence-count shadowing-topic-label">${state.customDrillText ? 'Weak-word drill' : `<span class="sh-topic-caption" dir="auto">Topic: ${escapeHtml(sentence?.topic ?? 'Offline practice')}</span><span class="sh-sentence-count">${hasLanguageSentenceSet ? `Sentence ${state.index + 1} of ${activeSet?.sentences.length ?? 0}` : 'No sentence set yet'}</span>`}</p>
      <div class="sentence-box" id="sh-target-text" dir="auto">${escapeHtml(targetText)}</div>
      <p class="card-subtitle sh-focus-copy">
        ${
          state.customDrillText
            ? 'Weak-word practice is active — choose Full Sentence to return.'
            : `Focus: ${escapeHtml(sentence?.phoneticFocus ?? 'Generate a sentence to see its pronunciation focus')}`
        }
      </p>

      <div class="btn-row sh-player-controls" aria-label="Sentence playback controls">
        <button type="button" class="btn btn-secondary sh-player-icon-btn" id="sh-prev-btn" aria-label="Previous sentence" ${isCaptureBusy ? 'disabled' : ''} title="Previous sentence"><svg class="sh-player-symbol" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14M19 5 9 12l10 7z"/></svg></button>
        <button type="button" class="btn btn-primary sh-player-icon-btn sh-play-main-btn model-play-btn ${state.activeModelPlayback ? 'is-playing' : ''}" id="sh-play-normal-btn" ${hasSentence && (!isCaptureBusy || state.activeModelPlayback !== null) && (!isPlaybackActive || state.activeModelPlayback !== null) ? '' : 'disabled'} aria-label="${state.activeModelPlayback ? 'Stop model playback' : 'Play model at normal speed'}" title="${state.activeModelPlayback ? 'Stop playback' : 'Play model at normal speed'}" aria-busy="${Boolean(state.activeModelPlayback)}">
          ${state.activeModelPlayback ? '<svg class="sh-inline-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z"/></svg>' : '<svg class="sh-inline-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>'}
        </button>
        <button type="button" class="btn btn-secondary sh-player-icon-btn" id="sh-next-btn" aria-label="Next sentence" ${isCaptureBusy ? 'disabled' : ''} title="Next sentence"><svg class="sh-player-symbol" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v14M5 5l10 7L5 19z"/></svg></button>
        <button type="button" class="btn btn-secondary sh-player-icon-btn sh-slow-btn model-play-btn ${state.activeModelPlayback === 'slow' ? 'is-playing' : ''}" id="sh-play-slow-btn" ${hasSentence && (!state.activeModelPlayback || state.activeModelPlayback === 'slow') && !isCaptureBusy && (!isPlaybackActive || state.audioActivity === 'playingModel(slow)') ? '' : 'disabled'} aria-label="Slow playback at 0.72 speed" title="Slow playback (0.72×)" aria-busy="${state.activeModelPlayback === 'slow'}">
          ${state.activeModelPlayback === 'slow' ? '<span class="model-play-spinner" aria-hidden="true"></span>' : '<span aria-hidden="true">0.72×</span>'}
        </button>
      </div>
      ${state.customDrillText ? `<div class="sh-drill-exit-actions"><button type="button" class="btn btn-secondary" id="sh-exit-drill-btn">Full Sentence</button></div>` : ''}

      <div class="btn-row sh-record-controls">
        <button type="button" class="btn btn-record sh-record-action ${isRec ? 'is-recording' : ''} ${isStopping ? 'is-stopping' : ''}" id="sh-record-btn" ${hasSentence && !isStopping && !isPlaybackActive ? '' : 'disabled'} aria-label="${isStopping ? 'Finishing recording' : isRec ? 'Stop recording and score repetition' : 'Start recording repetition'}" aria-pressed="${isRec ? 'true' : 'false'}">
          ${isStopping ? 'Wait…' : isRec ? '<span class="recording-led" aria-hidden="true"></span> Stop &amp; Score <span class="recording-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>' : 'Record Repetition'}
        </button>
        <button type="button" class="sh-record-action" id="sh-stop-score-btn" hidden aria-hidden="true" tabindex="-1" aria-label="Finish recording and score repetition"></button>
      </div>



      ${
        state.emptyAttemptError
          ? `<div class="status-box fail" id="sh-empty-error" role="alert">${escapeHtml(
              state.emptyAttemptError
            )} (Score: 0)</div>`
          : `${state.navigationNotice ? '<div class="status-box fail" role="alert">' + escapeHtml(state.navigationNotice) + '</div>' : '<div class="status-box info" id="sh-status-msg" role="status" aria-live="polite">' + escapeHtml(state.statusMessage) + '</div>'}`
      }

      ${resultStripHtml}
    <section class="sh-result-details">
      ${state.lastReport ? renderReportHtml(state.lastReport, Boolean(state.lastRecording?.wavBase64), drillMode, state.drillPreviousStatuses, isCaptureBusy, isPlaybackActive, isWordPlayback, weakActionHtml) : ''}
      <details class="sh-transcript-details" ${state.recognizerError ? 'open' : ''}>
        <summary>Transcript &amp; recognition details</summary>
        <div class="form-field sh-transcript-field">
          <label class="form-label" for="sh-transcript-input">Recognized speech</label>
          <input
            type="text"
            class="form-input"
            id="sh-transcript-input"
            readonly
            placeholder="Your speech will appear here."
            value="${escapeHtml(state.recognizedTranscript)}"
          />
          <div class="card-subtitle sh-recognizer-meta" id="sh-recognizer-meta">
            Alternatives / Confidence: ${altsHtml}
            ${state.recognizerError ? ` · Recognizer Note: ${escapeHtml(state.recognizerError)}` : ''}
          </div>
        </div>
      </details>
    </section>
    </div>

    <details class="sh-translation-disclosure" id="sh-translation-disclosure">
      <summary>Translate &amp; explain grammar</summary>
    <section class="card sh-translation-card" id="sh-translation-card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Translation &amp; Grammar</h2>
          <p class="card-subtitle">Edit the sentence or enter a single word, choose a language, then translate.</p>
        </div>
      </div>
      <div class="form-field">
        <label class="form-label" for="sh-translation-input">Text to translate</label>
        <textarea class="form-input sh-translation-input" id="sh-translation-input" rows="3" maxlength="4000" placeholder="Your sentence or word will appear here." ${state.isTranslating ? 'disabled' : ''}>${escapeHtml(state.translationText)}</textarea>
      </div>
      <div class="sh-translation-controls">
        <div class="form-field sh-translation-language-field">
          <label class="form-label" for="sh-translation-language">Translate into</label>
          <select class="form-select" id="sh-translation-language" ${state.isTranslating ? 'disabled' : ''}>${renderTranslationLanguageOptions(state.translationTargetLanguage)}</select>
        </div>
        <div class="sh-translation-actions">
          <button type="button" class="btn btn-secondary sh-translate-btn" id="sh-translate-btn" ${state.isTranslating ? 'disabled' : ''}>Translate</button>
          <button type="button" class="btn btn-secondary sh-grammar-btn" id="sh-grammar-btn" ${state.isTranslating ? 'disabled' : ''}>Explain Grammar</button>
        </div>
      </div>
      ${state.translationResult ? `<div class="sh-translation-result" id="sh-translation-result"><div class="form-label">Translation</div><p dir="auto">${escapeHtml(state.translationResult)}</p></div>` : ''}
      ${state.grammarResult ? `<div class="sh-translation-result sh-grammar-result" id="sh-grammar-result"><div class="form-label">Grammar explanation</div><div dir="auto">${escapeHtml(state.grammarResult).replace(/\n/g, '<br>')}</div></div>` : ''}
      ${state.translationStatus ? `<div class="status-box ${state.translationStatusType}" id="sh-translation-status" role="status" aria-live="polite">${escapeHtml(state.translationStatus)}</div>` : ''}
    </section>
    </details>
      <details class="offline-quality-notice sh-api-capability-notice" id="sh-api-capability-notice" aria-label="Speech API capability notice" ${state.forceSpeechApiNotice ? '' : 'hidden'} ${state.forceSpeechApiNotice ? 'open' : ''}>
        <summary><strong>Speech API compatibility &amp; troubleshooting</strong></summary>
        <strong>Important: speech APIs have separate capabilities</strong>
        <p>Text-to-speech (TTS: text → audio) and speech-to-text (STT: audio → text) are independent services. An API configured for one does not automatically provide the other. If your selected API/model does not offer text-to-speech or speech-to-text, that missing capability is a limitation of the selected API—not a Shadowing bug, and SpeakCoach cannot add it. API 2 is only a backup/rotation account; it may use the same provider, model, or endpoint as API 1, so it is not necessarily a different capability or an independent fallback. If playback or transcription fails, check the selected provider, exact model name, endpoint path, and whether that API actually supports the required audio operation. A successful connection test alone may not prove both directions work.</p>
        <p>For custom OpenAI-compatible APIs, enter the exact model name supported by your gateway. The suggested model list is only a convenience, not a restriction. Your gateway must expose the matching <code>/audio/speech</code> or <code>/audio/transcriptions</code> endpoint.</p>
        <button type="button" class="btn btn-secondary sh-api-notice-dismiss" id="sh-api-notice-dismiss-btn">I understand</button>
      </details>
  `;

  if (isCaptureBusy) {
    container.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select').forEach(control => {
      if (control.id === 'sh-stop-score-btn' || (control.id === 'sh-record-btn' && isRec && !isStopping)) return;
      control.disabled = true;
      control.setAttribute('aria-disabled', 'true');
    });
  }

  if (isSpeechApiNoticeDismissed()) {
    const notice = container.querySelector<HTMLDetailsElement>('.sh-api-capability-notice');
    if (notice) { notice.hidden = true; notice.open = false; }
    container.querySelector<HTMLButtonElement>('#sh-api-notice-toggle-btn')?.remove();
  }

  container.querySelector<HTMLButtonElement>('#sh-empty-generate-btn')?.addEventListener('click', () => {
    container.querySelector<HTMLButtonElement>('#sh-generate-ai-btn')?.click();
  });
    container.querySelector<HTMLButtonElement>('#sh-api-notice-toggle-btn')?.addEventListener('click', () => {
    const notice = container.querySelector<HTMLDetailsElement>('.sh-api-capability-notice');
    if (notice) { notice.hidden = false; notice.open = !notice.open; }
  });
    container.querySelector<HTMLDetailsElement>('.sh-api-capability-notice')?.querySelector<HTMLButtonElement>('#sh-api-notice-dismiss-btn')?.addEventListener('click', () => {
    try { localStorage.setItem(SPEECH_API_NOTICE_DISMISSED_KEY, 'true'); } catch { /* Dismiss for this render even if storage is unavailable. */ }
    state.forceSpeechApiNotice = false;
    container.querySelector('.sh-api-capability-notice')?.setAttribute('hidden', '');
    container.querySelector<HTMLButtonElement>('#sh-api-notice-toggle-btn')?.remove();
  });

  container.querySelector<HTMLSelectElement>('#sh-language-select')?.addEventListener('change', async event => {
    if (isAudioCaptureBusy() || isAudioPlaybackActive() || state.isGeneratingAi) return;
    const nextCode = (event.target as HTMLSelectElement).value as ShadowingLanguageCode;
    if (!SHADOWING_LANGUAGES.some(language => language.code === nextCode) || nextCode === state.languageCode) return;
    await persistCurrentShadowingHistory();
    state.languageCode = nextCode;
    await saveSelectedShadowingLanguage(nextCode);
    const nextHistory = getShadowingHistoryForLanguage(sentenceLanguageHistories, nextCode);
    sentenceSetHistory = nextHistory ?? createShadowingHistoryForLanguage(nextCode);
    if (!nextHistory) await persistCurrentShadowingHistory();
    state.index = sentenceSetHistory[state.difficulty].activeSentenceIndex;
    state.customDrillText = null;
    state.aiGenerationError = null;
    clearAttemptState();
    stopAllTts();
    renderShadowingView(container, summary);
  });

  container.querySelector<HTMLTextAreaElement>('#sh-translation-input')?.addEventListener('input', event => {
    state.translationText = (event.target as HTMLTextAreaElement).value;
    state.translationResult = '';
    state.translationStatus = null;
    container.querySelector('#sh-translation-result')?.remove();
    container.querySelector('#sh-grammar-result')?.remove();
    container.querySelector('#sh-translation-status')?.remove();
  });
  container.querySelector<HTMLSelectElement>('#sh-translation-language')?.addEventListener('change', event => {
    state.translationTargetLanguage = (event.target as HTMLSelectElement).value;
    state.translationResult = '';
    state.translationStatus = null;
    container.querySelector('#sh-translation-result')?.remove();
    container.querySelector('#sh-translation-status')?.remove();
  });
  const runTranslationAction = async (mode: 'translate' | 'grammar'): Promise<void> => {
    if (state.isTranslating) return;
    const textToTranslate = state.translationText.trim();
    const requestTargetLanguage = state.translationTargetLanguage;
    if (!textToTranslate) {
      state.translationStatus = 'Enter a word or sentence to translate.';
      state.translationStatusType = 'fail';
      renderShadowingView(container, summary);
      return;
    }
    state.isTranslating = true;
    state.translationMode = mode;
    state.translationResult = '';
    state.grammarResult = '';
    state.translationStatus = mode === 'grammar' ? 'Explaining grammar with the configured Translation API…' : 'Translating with the configured Translation API…';
    state.translationStatusType = 'info';
    renderShadowingView(container, summary);
    try {
      const targetLanguage = TRANSLATION_LANGUAGES.find(language => language.code === requestTargetLanguage)?.label ?? requestTargetLanguage;
      const result = await translateShadowingText(textToTranslate, targetLanguage, undefined, mode);
      if (state.translationText.trim() === textToTranslate && state.translationTargetLanguage === requestTargetLanguage) {
        if (mode === 'grammar') state.grammarResult = result.text;
        else state.translationResult = result.text;
        state.translationStatus = `${mode === 'grammar' ? 'Grammar explanation' : 'Translation'} complete via ${result.providerName} (${result.account === 'secondary' ? 'API 2' : 'API 1'}).`;
        state.translationStatusType = 'pass';
      }
    } catch (error) {
      if (state.translationText.trim() === textToTranslate && state.translationTargetLanguage === requestTargetLanguage) {
        state.translationStatus = `Translation failed: ${error instanceof Error ? error.message : String(error)}`;
        state.translationStatusType = 'fail';
      }
    } finally {
      state.isTranslating = false;
      renderShadowingView(container, summary);
    }
  };
  container.querySelector<HTMLButtonElement>('#sh-translate-btn')?.addEventListener('click', () => { void runTranslationAction('translate'); });
  container.querySelector<HTMLButtonElement>('#sh-grammar-btn')?.addEventListener('click', () => { void runTranslationAction('grammar'); });

  container.querySelectorAll<HTMLButtonElement>('[data-word-replay]').forEach(button => {
    button.addEventListener('click', async () => {
      const word = button.dataset.wordReplay?.trim();
      if (!word) return;
      state.navigationNotice = null;
      if (state.audioActivity === 'playingWord') { shadowingModelPlaybackToken++; stopAllTts(); state.audioActivity = 'idle'; state.statusMessage = 'Word playback stopped.'; renderShadowingView(container, summary); return; }
      if (isAudioCaptureBusy() || isAudioPlaybackActive() || button.disabled) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      const wordPlaybackToken = ++shadowingModelPlaybackToken;
      state.activeModelPlayback = null;
      stopAllTts();
      state.audioActivity = 'playingWord';
      renderShadowingView(container, summary);
      try {
        const audioContext = await audioSetContextPromise;
        if (wordPlaybackToken !== shadowingModelPlaybackToken || state.audioActivity !== 'playingWord') return;
        const result = await speakSentenceWithTierFallback(word, {
          locale: selectedLanguage.locale,
          shadowingSetAudio: audioContext ? { ...audioContext, kind: 'extra' } : undefined
        });
        state.statusMessage = `Played “${word}” via ${result.activeTier.detailLabel}.`;
      } catch (error) {
        reopenSpeechApiNoticeForError(error);
        state.statusMessage = `Could not play “${word}”: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        if (wordPlaybackToken === shadowingModelPlaybackToken && state.audioActivity === 'playingWord') {
          state.audioActivity = 'idle';
          renderShadowingView(container, summary);
        }
      }
    });
  });

    container.querySelectorAll<HTMLButtonElement>('[data-diff]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (isAudioCaptureBusy() || isAudioPlaybackActive()) return;
      state.difficulty = (btn.dataset.diff as ShadowingDifficulty) || 'easy';
      state.index = sentenceSetHistory?.[state.difficulty].activeSentenceIndex ?? 0;
      state.customDrillText = null;
      state.aiGenerationError = null;
      clearAttemptState();
      renderShadowingView(container, summary);
    });
  });

  container.querySelector<HTMLInputElement>('#sh-topic-input')?.addEventListener('input', event => {
    state.topicInput = (event.target as HTMLInputElement).value;
  });

  container.querySelector<HTMLButtonElement>('#sh-generate-ai-btn')?.addEventListener('click', async () => {
    if (state.isGeneratingAi || isAudioCaptureBusy() || isAudioPlaybackActive()) return;
    state.isGeneratingAi = true;
    state.aiGenerationError = null;
    state.statusMessage = 'Generating 20 new practice sentences...';
    renderShadowingView(container, summary);
    try {
      const generated = await generateAiShadowingSentenceBatch(state.difficulty, 20, state.topicInput.trim(), undefined, state.languageCode);
      sentenceSetHistory = appendShadowingSet(sentenceSetHistory!, state.difficulty, generated);
      await persistCurrentShadowingHistory();
      state.index = 0;
      state.customDrillText = null;
      clearAttemptState();
      state.statusMessage = `Added a new set of 20 sentences by ${generated[0]?.providerName ?? 'AI'} to your history.`;
      state.aiGenerationError = null;
    } catch (error) {
      state.aiGenerationError = `AI sentence set generation failed: ${error instanceof Error ? error.message : String(error)}`;
      state.statusMessage = 'The current sentence set was kept. Correct the issue above and try again.';
    } finally {
      state.isGeneratingAi = false;
      renderShadowingView(container, summary);
    }
  });

  container.querySelector<HTMLButtonElement>('#sh-history-prev-btn')?.addEventListener('click', async () => {
    if (!sentenceSetHistory || isAudioCaptureBusy() || isAudioPlaybackActive()) return;
    state.navigationNotice = null;
    sentenceSetHistory = moveShadowingSet(sentenceSetHistory, state.difficulty, -1);
    state.index = 0;
    state.customDrillText = null;
    state.aiGenerationError = null;
    clearAttemptState();
    await persistCurrentShadowingHistory();
    renderShadowingView(container, summary);
  });

  container.querySelector<HTMLButtonElement>('#sh-history-next-btn')?.addEventListener('click', async () => {
    if (!sentenceSetHistory || isAudioCaptureBusy() || isAudioPlaybackActive()) return;
    state.navigationNotice = null;
    sentenceSetHistory = moveShadowingSet(sentenceSetHistory, state.difficulty, 1);
    state.index = 0;
    state.customDrillText = null;
    state.aiGenerationError = null;
    clearAttemptState();
    await persistCurrentShadowingHistory();
    renderShadowingView(container, summary);
  });

  container.querySelector<HTMLButtonElement>('#sh-prev-btn')?.addEventListener('click', async () => {
    if (isAudioCaptureBusy() || isAudioPlaybackActive()) return;
    state.navigationNotice = null;
    state.index = Math.max(0, state.index - 1);
    if (sentenceSetHistory) {
      sentenceSetHistory = selectShadowingSentence(sentenceSetHistory, state.difficulty, state.index);
      await persistCurrentShadowingHistory();
    }
    state.customDrillText = null;
    state.drillWords = [];
    state.drillPreviousStatuses = {};
    clearAttemptState();
    renderShadowingView(container, summary);
  });

  container.querySelector<HTMLButtonElement>('#sh-next-btn')?.addEventListener('click', async () => {
    if (isAudioCaptureBusy() || isAudioPlaybackActive()) return;
    if (!state.customDrillText && state.index >= (activeSet?.sentences.length ?? 0) - 1) {
      state.navigationNotice = "You've reached the end of this sentence set. Generate a new set, or go back through your history to practice a previous one.";
      renderShadowingView(container, summary);
      return;
    }
    state.navigationNotice = null;
    state.navigationNotice = null;
    state.index = Math.min(Math.max(0, (activeSet?.sentences.length ?? 1) - 1), state.index + 1);
    if (sentenceSetHistory) {
      sentenceSetHistory = selectShadowingSentence(sentenceSetHistory, state.difficulty, state.index);
      await persistCurrentShadowingHistory();
    }
    state.customDrillText = null;
    state.drillWords = [];
    state.drillPreviousStatuses = {};
    clearAttemptState();
    startShadowingPrefetch();
    renderShadowingView(container, summary);
  });

  container.querySelector<HTMLButtonElement>('#sh-exit-drill-btn')?.addEventListener('click', () => {
    if (isAudioCaptureBusy() || isAudioPlaybackActive()) return;
    state.customDrillText = null;
    state.drillWords = [];
    state.drillPreviousStatuses = {};
    clearAttemptState();
    startShadowingPrefetch();
    renderShadowingView(container, summary);
  });

  const playModelAudio = async (mode: 'normal' | 'slow'): Promise<void> => {
    if (isAudioCaptureBusy() || isAudioPlaybackActive()) return;
    state.navigationNotice = null;
    const playbackToken = ++shadowingModelPlaybackToken;
    state.activeModelPlayback = mode;
    state.audioActivity = mode === 'normal' ? 'playingModel(normal)' : 'playingModel(slow)';
    state.statusMessage = 'Generating audio…';
    renderShadowingView(container, summary);
    try {
      const rate = mode === 'normal' ? 1.0 : 0.72;
      const audioContext = await audioSetContextPromise;
      if (playbackToken !== shadowingModelPlaybackToken) return;
      const res = await speakSentenceWithTierFallback(targetText, {
        rate,
        locale: selectedLanguage.locale,
        shadowingSetAudio: audioContext ? { ...audioContext, kind: state.customDrillText || rate !== 1 ? 'extra' : 'sentence' } : undefined,
        onPlaybackStart: () => {
          if (playbackToken !== shadowingModelPlaybackToken) return;
          state.statusMessage = mode === 'normal' ? 'Playing model audio at normal speed…' : 'Playing model audio slowly…';
          renderShadowingView(container, summary);
          if (mode === 'normal') startShadowingPrefetch();
        }
      });
      if (playbackToken !== shadowingModelPlaybackToken) return;
      const offlineVoiceNote = res.activeTier.tier >= 3
        ? shadowingTier3FallbackNoticeShown
          ? ''
          : ` The basic offline system voice is being used. ${res.activeTier.reason ?? 'The online voice is not currently available.'} Open Settings → Voice/TTS to re-test the provider or configure API 2.`
        : res.activeTier.reason ? ` Notice: ${res.activeTier.reason}` : '';
      if (res.activeTier.tier >= 3) shadowingTier3FallbackNoticeShown = true;
      const playbackTierLabel = res.activeTier.tier >= 3 ? 'Basic offline' : res.activeTier.detailLabel;
      if (res.storageWarning) console.warn('[Shadowing] Audio played but could not be retained for offline replay.', res.storageWarning);
      state.statusMessage = mode === 'normal'
        ? `Played model audio via ${playbackTierLabel}${res.fromCache ? ' [Cached]' : ''}.${offlineVoiceNote}`
        : `Played slow model audio (0.72x) via ${playbackTierLabel}.${offlineVoiceNote}`;
    } catch (error) {
      if (playbackToken !== shadowingModelPlaybackToken) return;
      reopenSpeechApiNoticeForError(error);
      state.statusMessage = `Could not play model audio: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (playbackToken === shadowingModelPlaybackToken) {
        state.activeModelPlayback = null;
        state.audioActivity = 'idle';
        startShadowingPrefetch(); // Retry any batch deferred by user-initiated synthesis.
        renderShadowingView(container, summary);
      }
    }
  };

  container.querySelector<HTMLButtonElement>('#sh-play-normal-btn')?.addEventListener('click', () => {
    if (state.activeModelPlayback !== null) {
      shadowingModelPlaybackToken++;
      stopAllTts();
      state.activeModelPlayback = null;
      state.audioActivity = 'idle';
      state.statusMessage = 'Model playback stopped.';
      renderShadowingView(container, summary);
      return;
    }
    if (isAudioCaptureBusy() || isAudioPlaybackActive()) return;
    void playModelAudio('normal');
  });

  container.querySelector<HTMLButtonElement>('#sh-play-slow-btn')?.addEventListener('click', () => {
    state.navigationNotice = null;
    if (state.activeModelPlayback === 'slow') {
      shadowingModelPlaybackToken++;
      stopAllTts();
      state.activeModelPlayback = null;
      state.audioActivity = 'idle';
      state.statusMessage = 'Model playback stopped.';
      renderShadowingView(container, summary);
      return;
    }
    if (isAudioCaptureBusy() || isAudioPlaybackActive()) return;
    void playModelAudio('slow');
  });

  // Shadowing always uses its own pronunciation-scoring slot. Never borrow
  // the IELTS transcription API: the two features have independent providers,
  // keys, verification and fallback/rotation.
  const resolveShadowingSttSlotId = (): 'pronunciation_scoring' => 'pronunciation_scoring';

  container.querySelector<HTMLButtonElement>('#sh-record-btn')?.addEventListener('click', async () => {
    if (audioRecorder.isRecording()) {
      container.querySelector<HTMLButtonElement>('#sh-stop-score-btn')?.click();
      return;
    }
    if (isAudioCaptureBusy() || isAudioPlaybackActive()) return;
    const recordButton = container.querySelector<HTMLButtonElement>('#sh-record-btn');
    if (recordButton) recordButton.disabled = true;
    // User has begun a practice attempt; opportunistic audio prefetch may start now.
    startShadowingPrefetch();
    // Always reset transcript & previous report to EMPTY on every new recording attempt
    clearAttemptState();
    state.audioActivity = 'recording';
    const sttSlotId = resolveShadowingSttSlotId();
    const sttTier = summary.slots[sttSlotId];
    const isOnlineStt = sttTier.tier <= 2 && sttTier.label === 'Online AI';

    try {
      await audioRecorder.start(selectedLanguage.locale, { useOfflineRecognizer: !isOnlineStt, preferOffline: !isOnlineStt });
      if (viewGeneration !== shadowingViewGeneration) {
        if (audioRecorder.isRecording()) await audioRecorder.stop();
        state.audioActivity = 'idle';
        return;
      }
      clearShadowingRecordingTimer();
      // A 30-second ceiling comfortably covers long practice sentences while preventing runaway recording.
      // Trigger the same stop-and-score flow the user would invoke manually.
      shadowingRecordingTimeout = setTimeout(() => {
        shadowingRecordingTimeout = null;
        container.querySelector<HTMLButtonElement>('#sh-stop-score-btn')?.click();
      }, 30_000);
      state.statusMessage = isOnlineStt
        ? 'Recording 16 kHz WAV (Online STT mode)... Speak clearly, then tap "Stop & Score". Recording stops automatically after 30 seconds.'
        : 'Listening via device/browser speech recognition. The browser may use its own network speech service; SpeakCoach does not upload raw audio in this mode. Recording stops automatically after 30 seconds.';
    } catch (err) {
      state.audioActivity = 'idle';
      if (viewGeneration !== shadowingViewGeneration) return;
      state.statusMessage = `Microphone error: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (viewGeneration !== shadowingViewGeneration) return;
    renderShadowingView(container, summary);
  });

  container.querySelector<HTMLButtonElement>('#sh-stop-score-btn')?.addEventListener('click', async () => {
    if (shadowingIsStopping) return;
    shadowingIsStopping = true;
    state.audioActivity = 'stopping/scoring';
    setShadowingCaptureControlsDisabled(container, true);
    clearShadowingRecordingTimer();
    const visibleStopButton = container.querySelector<HTMLButtonElement>('#sh-record-btn');
    if (visibleStopButton) {
      visibleStopButton.disabled = true;
      visibleStopButton.classList.add('is-stopping');
      visibleStopButton.textContent = 'Wait…';
      visibleStopButton.setAttribute('aria-label', 'Finishing recording');
    }
    const rec = await audioRecorder.stop().catch((error) => {
      if (viewGeneration === shadowingViewGeneration) {
        shadowingIsStopping = false;
        state.audioActivity = 'idle';
        state.statusMessage = `Could not stop recording: ${error instanceof Error ? error.message : String(error)}`;
        renderShadowingView(container, summary);
      }
      return null;
    });
    if (!rec || viewGeneration !== shadowingViewGeneration) {
      shadowingIsStopping = false;
      state.audioActivity = 'idle';
      if (viewGeneration === shadowingViewGeneration) renderShadowingView(container, summary);
      return;
    }
    state.lastRecording = rec;

    // Resolve the configured online speech provider (Azure, Whisper or Gemini), with API 2 and offline fallbacks.
    const sttSlotId = resolveShadowingSttSlotId();

    const sttOutcome = await transcribeWithTier2WhisperOrFallback({
      slotId: sttSlotId,
      wavBase64: rec.wavBase64,
      durationMs: rec.durationMs,
      offlineTranscript: rec.offlineTranscript,
      offlineConfidence: rec.offlineConfidence,
      referenceText: targetText,
      languageCode: state.languageCode,
      languageLocale: selectedLanguage.locale
    }).catch((error) => {
      if (viewGeneration === shadowingViewGeneration) {
        state.statusMessage = `Speech transcription failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      return null;
    });
    if (!sttOutcome || viewGeneration !== shadowingViewGeneration) {
      shadowingIsStopping = false;
      state.audioActivity = 'idle';
      if (viewGeneration === shadowingViewGeneration) renderShadowingView(container, summary);
      return;
    }

    const rawRecognized = sttOutcome.transcript.trim();

    state.recognizedTranscript = rawRecognized;
    state.recognizedConfidence = rec.offlineConfidence;
    state.recognizedAlternatives = rec.offlineAlternatives;
    state.recognizerError = sttOutcome.error ?? rec.recognizerError;
    if (rec.recognizerError && isSpeechApiRelatedError(rec.recognizerError)) {
      reopenSpeechApiNoticeForError(rec.recognizerError);
    }

    // Never fall back to reference text! If recognizer returned empty/null/error, DO NOT score.
    if (!rawRecognized) {
      state.lastReport = null;
      state.emptyAttemptError = state.customDrillText
        ? 'No words were recognized for this weak-word drill. Your previous results are kept; retry when ready.'
        : sttOutcome.error
        ? `${sttOutcome.error} Retry the recording or use the device recognizer.`
        : rec.recognizerError
          ? `Nothing was recognized, try again (${rec.recognizerError}).`
          : 'Nothing was recognized, try again.';

      await recordLastShadowingAttempt({
        referenceText: targetText,
        rawRecognizerText: '',
        recognizerConfidence: 0,
        recognizerAlternatives: [],
        recognizerError: rec.recognizerError,
        sttWordTimestamps: [],
        sttActiveTierLabel: sttOutcome.activeTier.detailLabel,
        report: null
      });
      clearDiagnosticsCache();
      shadowingIsStopping = false;
      state.audioActivity = 'idle';
      renderShadowingView(container, summary);
      return;
    }

    state.emptyAttemptError = null;
    const vadAnalysis = rec.wavBase64
      ? analyzeWavBase64Vad(rec.wavBase64, targetExpectedDurationMs)
      : undefined;
    const modelTimings = state.languageCode === 'en' ? (await getCachedModelWordTimings(targetText)) ?? undefined : undefined;

    if (sttOutcome.activeTier.tier <= 2 && sttOutcome.words.length > 0) {
      state.lastReport = scoreShadowingTier2({
        referenceText: targetText,
        spokenTranscript: rawRecognized,
        spokenTokens: sttOutcome.words,
        spokenDurationMs: rec.durationMs,
        expectedDurationMs: targetExpectedDurationMs,
        activeTierOverride: sttOutcome.activeTier,
        vadAnalysis,
        referenceTimingsOverride: modelTimings,
        languageCode: state.languageCode
      });
    } else {
      state.lastReport = scoreShadowingOfflineTier3({
        referenceText: targetText,
        spokenTranscript: rawRecognized,
        spokenDurationMs: rec.durationMs,
        expectedDurationMs: targetExpectedDurationMs,
        confidence: rec.offlineConfidence,
        spokenTokensOverride: sttOutcome.words.length > 0 ? sttOutcome.words : undefined,
        activeTierOverride: scoringTier,
        vadAnalysis,
        referenceTimingsOverride: modelTimings,
        languageCode: state.languageCode
      });
    }

    await recordLastShadowingAttempt({
      referenceText: targetText,
      rawRecognizerText: rawRecognized,
      recognizerConfidence: rec.offlineConfidence,
      recognizerAlternatives: rec.offlineAlternatives,
      recognizerError: rec.recognizerError,
      sttWordTimestamps: sttOutcome.words,
      sttActiveTierLabel: sttOutcome.activeTier.detailLabel,
      report: state.lastReport
    });
    clearDiagnosticsCache();

    state.statusMessage = `${sttOutcome.error ? `${sttOutcome.error} ` : ''}Scored recognizer output ("${rawRecognized}") against reference.`;
    shadowingIsStopping = false;
    state.audioActivity = 'idle';
    startShadowingPrefetch();
    renderShadowingView(container, summary);
  });

  const playMyRecording = async (mode: 'normal' | 'slow'): Promise<void> => {
    const activity = mode === 'normal' ? 'playingMine(normal)' : 'playingMine(slow)';
    state.navigationNotice = null;
    if (state.audioActivity === activity) {
      stopAllTts();
      state.audioActivity = 'idle';
      state.statusMessage = 'Recording playback stopped.';
      renderShadowingView(container, summary);
      return;
    }
    if (!state.lastRecording || isAudioCaptureBusy() || isAudioPlaybackActive()) return;
    state.audioActivity = activity;
    renderShadowingView(container, summary);
    try {
      await playAudioDataUrl(state.lastRecording.wavDataUrl, mode === 'normal' ? 1.0 : 0.75);
    } finally {
      if (state.audioActivity === activity) {
        state.audioActivity = 'idle';
        renderShadowingView(container, summary);
      }
    }
  };
  container.querySelector<HTMLButtonElement>('#sh-replay-my-audio-btn')?.addEventListener('click', () => { void playMyRecording('normal'); });
  container.querySelector<HTMLButtonElement>('#sh-replay-my-slow-btn')?.addEventListener('click', () => { void playMyRecording('slow'); });

  container.querySelector<HTMLButtonElement>('#sh-retry-weak-btn')?.addEventListener('click', () => {
    if (!state.lastReport || isAudioCaptureBusy() || isAudioPlaybackActive()) return;
    const words = [...new Set(state.lastReport.words.filter(word => word.referenceWord && word.status !== 'match').map(word => word.referenceWord!))];
    if (!words.length) return;
    state.drillPreviousStatuses = Object.fromEntries(state.lastReport.words.filter(word => word.referenceWord).map(word => [word.referenceWord!, { status: word.status, accuracyScore: word.accuracyScore }]));
    state.drillWords = words;
    state.customDrillText = words.join(' ');
    clearAttemptState();
    state.statusMessage = 'Focused Weak-Word Drill ready! Listen and repeat only your weak words.';
    renderShadowingView(container, summary);
  });

  // Release any position window reached from a saved starting position or a re-render.
  // The scheduler and in-flight map make this idempotent.
  void startShadowingPrefetch();

  // The main router invokes this when leaving Shadowing. Invalidate pending
  // async recording/scoring work before stopping native capture and playback.
  return () => {
    shadowingViewGeneration++;
    clearShadowingRecordingTimer();
    shadowingModelPlaybackToken++;
    state.activeModelPlayback = null;
    state.audioActivity = 'idle';
    stopAllTts();
    shadowingPrefetchEpoch++;
    shadowingPrefetchWindowKey = '';
    shadowingPrefetchScheduler.reset();
    shadowingIsStopping = false;
    if (audioRecorder.isRecording()) {
      void audioRecorder.stop().catch((error) => {
        console.warn('[SpeakCoach] Could not stop Shadowing recording during navigation cleanup.', error);
      });
    }
  };
}

export async function pauseShadowingRecordingForBackground(): Promise<void> {
  clearShadowingRecordingTimer();
  const wasScoring = state.audioActivity === 'stopping/scoring';
  if (!wasScoring) shadowingIsStopping = false;
  shadowingModelPlaybackToken++;
  const wasPlayingAudio = isAudioPlaybackActive();
  state.activeModelPlayback = null;
  if (!wasScoring) state.audioActivity = 'idle';
  const wasRecording = audioRecorder.isRecording();
  if (wasScoring) return;
  if (!wasRecording && !wasPlayingAudio) return;
  stopAllTts();

  try {
    if (wasRecording) await audioRecorder.stop();
    state.statusMessage = wasPlayingAudio
      ? 'Audio playback stopped because SpeakCoach moved to the background. Play it again when you return.'
      : 'Recording stopped because SpeakCoach moved to the background. Start a new recording when you return.';
  } catch (error) {
    state.statusMessage = `Audio was interrupted in the background. Please try again. ${error instanceof Error ? error.message : ''}`.trim();
  }
}

export function resetShadowingViewState(): void {
  state.forceSpeechApiNotice = false;
  shadowingModelPlaybackToken++;
  stopAllTts();
  state.activeModelPlayback = null;
  state.audioActivity = 'idle';
  shadowingIsStopping = false;
  state.difficulty = 'easy';
  state.isGeneratingAi = false;
  state.aiGenerationError = null;
  clearShadowingRecordingTimer();
  state.index = sentenceSetHistory?.[state.difficulty].activeSentenceIndex ?? 0;
  state.topicInput = '';
  state.customDrillText = null;
  state.drillWords = [];
  state.drillPreviousStatuses = {};
  state.translationSourceText = null;
  state.translationText = '';
  state.translationResult = '';
  state.translationStatus = null;
  state.isTranslating = false;
  clearAttemptState();
}
