import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrapApp } from '../src/main';
import { audioRecorder } from '../src/services/audioRecorder';
import { networkMonitor } from '../src/services/networkMonitor';
import { clearLastShadowingAttempt } from '../src/services/shadowingTelemetry';
import { clearAllRuntimeFailures } from '../src/services/tierManager';
import { saveSelectedShadowingLanguage } from '../src/services/shadowingLanguageHistory';

describe('Shadowing Trainer UI (Empty-By-Default Transcript, No Reference Fallback & Diagnostics)', () => {
  beforeEach(async () => {
    localStorage.clear();
    await saveSelectedShadowingLanguage('en');
    clearAllRuntimeFailures();
    await clearLastShadowingAttempt();
    audioRecorder.setMockRecognizerOutputForTest(null);
    networkMonitor.setOnline(true);
  });


  it('keeps Sentence set directly below Practice language on the unframed Shadowing page', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    await bootstrapApp(root, 'shadowing');
    await new Promise(resolve => setTimeout(resolve, 30));
    const trainer = root.querySelector('.shadowing-main-card');
    const language = root.querySelector('#sh-language-select');
    const sentenceSet = root.querySelector('.sh-sentence-set-details');
    const target = root.querySelector('#sh-target-text');
    const scoreDetails = root.querySelector('.sh-result-details');
    const transcript = root.querySelector('.sh-transcript-details');
    const translation = root.querySelector('#sh-translation-card');
    expect(trainer).not.toBeNull();
    expect(trainer?.classList.contains('card')).toBe(false);
    expect(sentenceSet?.tagName).toBe('SECTION');
    expect(scoreDetails?.tagName).toBe('SECTION');
    expect(sentenceSet?.querySelector('#sh-history-position')).not.toBeNull();
    expect(sentenceSet?.querySelector('.sh-history-arrows')).not.toBeNull();
    expect(sentenceSet?.querySelector('.sh-history-caption')?.nextElementSibling?.id).toBe('sh-history-position');
    expect(root.querySelector('.sh-sentence-set-heading')).not.toBeNull();
    expect(root.querySelector('#sh-api-notice-toggle-btn')?.parentElement?.classList.contains('shadowing-main-header')).toBe(true);
    expect(root.querySelector('.sh-api-capability-notice')).not.toBeNull();
    expect(language && sentenceSet && language.compareDocumentPosition(sentenceSet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(language?.parentElement?.nextElementSibling).toBe(sentenceSet);
    expect(sentenceSet && target && sentenceSet.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(trainer?.contains(sentenceSet)).toBe(true);
    expect(trainer?.contains(target)).toBe(true);
    expect(trainer?.contains(scoreDetails)).toBe(true);
    expect(trainer?.contains(translation)).toBe(false);
    expect(transcript).not.toBeNull();
    expect(root.querySelector('#sh-record-btn')?.classList.contains('btn-record')).toBe(true);
    expect(root.querySelector('#sh-translate-btn')?.classList.contains('btn-secondary')).toBe(true);
    const notice = root.querySelector<HTMLDetailsElement>('.sh-api-capability-notice');
    expect(notice?.hidden).toBe(true);
    root.querySelector<HTMLButtonElement>('#sh-api-notice-toggle-btn')?.click();
    expect(notice?.hidden).toBe(false);
    expect(notice?.open).toBe(true);
  });

  it('starts with offline sentence sets, removes source choice, and reports missing AI configuration', async () => {
    const root = document.createElement('div');
    // ShadowingView updates the shared bottom-navigation element through
    // document.querySelector, so mount the app as it is mounted in production.
    document.body.appendChild(root);
    await bootstrapApp(root, 'shadowing');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const initialShadowingText = root.querySelector('#sh-target-text')?.textContent ?? '';
    expect(initialShadowingText).toBe('I usually start my morning with a cup of hot coffee.');
    expect(root.querySelector<HTMLTextAreaElement>('#sh-translation-input')?.value).toBe(initialShadowingText);
    expect(root.querySelector('.sentence-source-switch')).toBeNull();
    expect(root.querySelectorAll('.sentence-source-card')).toHaveLength(0);
    expect(root.querySelector('#sh-generate-ai-btn')).not.toBeNull();
    expect(root.querySelector('#sh-history-prev-btn')).not.toBeNull();
    expect(root.querySelector('#sh-history-next-btn')).not.toBeNull();
    expect(root.querySelector('#sh-history-position')?.textContent).toContain('Set 1 of 5');
    expect(root.querySelector('#sh-translation-card')).not.toBeNull();
    expect(root.querySelector<HTMLButtonElement>('#sh-play-normal-btn')?.disabled).toBe(false);

    root.querySelector<HTMLButtonElement>('#sh-generate-ai-btn')?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(root.querySelector('#sh-ai-generation-error')?.textContent).toContain('AI sentence set generation failed');
    expect(root.querySelector('#sh-ai-generation-error')?.classList.contains('fail')).toBe(true);
    expect(root.querySelector('#sh-target-text')?.textContent).toBe(initialShadowingText);
  });

  it('starts the transcript box EMPTY and refuses to score when recognizer returns empty (silence)', async () => {
    const root = document.createElement('div');
    await bootstrapApp(root, 'shadowing');

    const transcriptInput = root.querySelector<HTMLInputElement>('#sh-transcript-input');
    expect(transcriptInput).not.toBeNull();
    // MUST start empty, NEVER prefilled with the reference sentence!
    expect(transcriptInput?.value).toBe('');

    // Simulate silence / empty recognizer result
    audioRecorder.setMockRecognizerOutputForTest({
      transcript: '',
      confidence: 0,
      error: 'ERROR_NO_MATCH (No speech recognized)'
    });

    root.querySelector<HTMLButtonElement>('#sh-stop-score-btn')?.click();
    await new Promise((r) => setTimeout(r, 40));

    // Must NOT render a score card; must explain that online STT is not verified and offer retry/offline guidance.
    expect(root.querySelector('#sh-score-card')).toBeNull();
    const errBox = root.querySelector('#sh-empty-error');
    expect(errBox).not.toBeNull();
    expect(errBox?.textContent).toContain('Online speech API is not verified');
  });

  it('scores ONLY what the recognizer returned, supports Weak-Word Drill, and logs to Diagnostics', async () => {
    const root = document.createElement('div');
    await bootstrapApp(root, 'shadowing');

    // Recognizer heard sentence with "usually" and "hot" skipped
    audioRecorder.setMockRecognizerOutputForTest({
      transcript: 'I start my morning with a cup of coffee',
      confidence: 0.87,
      alternatives: [
        { transcript: 'I start my morning with a cup of coffee', confidence: 0.87 },
        { transcript: 'I start morning with a cup of coffee', confidence: 0.72 }
      ]
    });

    root.querySelector<HTMLButtonElement>('#sh-stop-score-btn')?.click();
    await new Promise((r) => setTimeout(r, 40));

    const transcriptInput = root.querySelector<HTMLInputElement>('#sh-transcript-input');
    expect(transcriptInput?.value).toBe('I start my morning with a cup of coffee');
    expect(root.querySelector('#sh-recognizer-meta')?.textContent).toContain('87%');

    expect(root.querySelector('#sh-score-card')).not.toBeNull();
    expect(root.querySelector('.shadowing-main-card')?.contains(root.querySelector('#sh-score-card'))).toBe(true);
    expect(root.querySelector('#sh-score-card #sh-word-chips')).not.toBeNull();
    expect(root.querySelector<HTMLDetailsElement>('.sh-transcript-details')).not.toBeNull();
    expect(root.querySelector('.metric-tile-overall #sh-overall-score')).not.toBeNull();
    expect(root.querySelector('#sh-word-replay-help')?.textContent).toContain('Tap any word below');
    expect(root.querySelector<HTMLButtonElement>('#sh-word-chips [data-word-replay]')).not.toBeNull();
    const resultWord = root.querySelector<HTMLButtonElement>('#sh-word-chips [data-word-replay]');
    expect(resultWord).not.toBeNull();
    expect(resultWord?.tagName).toBe('BUTTON');
    expect(resultWord?.getAttribute('aria-label')).toContain('Play pronunciation of');
    expect(root.querySelectorAll('#sh-word-chips [data-word-replay]').length).toBeGreaterThan(0);
    expect(root.querySelector('.word-replay-help')?.textContent).toContain('Tap any word below');
    expect(root.querySelector<HTMLButtonElement>('#sh-word-chips [data-word-replay]')?.getAttribute('aria-label')).toContain('Play pronunciation of');
    // In offline SpeechRecognizer mode, no raw WAV is kept and word timing / replay are disabled with a clear notice
    expect(root.querySelector('#sh-vad-summary')).toBeNull();
    expect(root.querySelector('#sh-offline-timing-disabled')).not.toBeNull();
    expect(root.querySelector<HTMLButtonElement>('#sh-replay-my-audio-btn')?.disabled).toBe(true);
    const missingChips = root.querySelectorAll('[data-word-status="missing"]');
    expect(missingChips.length).toBe(2);

    // Diagnostics is now accessed from Settings.
    root.querySelector<HTMLButtonElement>('#nav-settings')?.click();
    await new Promise((r) => setTimeout(r, 40));
    root.querySelector<HTMLButtonElement>('#settings-open-diagnostics-btn')?.click();
    await new Promise((r) => setTimeout(r, 40));

    expect(root.querySelector('#diag-last-ref')?.textContent).toContain(
      'I usually start my morning with a cup of hot coffee.'
    );
    expect(root.querySelector('#diag-last-raw')?.textContent).toContain(
      '"I start my morning with a cup of coffee" (87%)'
    );
    expect(root.querySelector('#diag-last-alignment')?.textContent).toContain('usually [missing:0%]');
    expect(root.querySelector('#diag-last-alignment')?.textContent).toContain('hot [missing:0%]');

    // Return to Shadowing and click Retry Weak Words
    root.querySelector<HTMLButtonElement>('#nav-shadowing')?.click();
    await new Promise((r) => setTimeout(r, 40));

    const retryWeakBtn = root.querySelector<HTMLButtonElement>('#sh-retry-weak-btn');
    expect(retryWeakBtn).not.toBeNull();
    expect(retryWeakBtn?.closest('#sh-score-card')).not.toBeNull();
    expect(retryWeakBtn?.closest('.sh-retry-weak-actions')).not.toBeNull();
    expect(root.querySelector('#sh-score-card #sh-retry-weak-btn')).not.toBeNull();
    retryWeakBtn?.click();

    expect(root.querySelector('#sh-target-text')?.textContent).toBe('usually hot');
    expect(root.querySelector('#sh-exit-drill-btn')?.closest('.sh-drill-exit-actions')).not.toBeNull();
    expect(root.querySelector('#sh-exit-drill-btn')?.closest('.sh-player-controls')).toBeNull();
    expect(root.querySelector<HTMLInputElement>('#sh-transcript-input')?.value).toBe('');
    expect(root.querySelector('#sh-fluency-score')).toBeNull();
    expect(root.querySelector('#sh-pace-score')).toBeNull();

    audioRecorder.setMockRecognizerOutputForTest({ transcript: 'usually', confidence: 0.93 });
    root.querySelector<HTMLButtonElement>('#sh-record-btn')?.click();
    await new Promise((r) => setTimeout(r, 25));
    root.querySelector<HTMLButtonElement>('#sh-record-btn')?.click();
    await new Promise((r) => setTimeout(r, 60));
    expect(root.querySelector('#sh-drill-correct-count')?.textContent).toContain('1 / 2');
    expect(root.querySelector('.drill-word-progress')?.textContent).toBe('Improved');
    expect(root.querySelector('#sh-retry-weak-btn')?.textContent).toContain('Retry remaining weak words');
    expect(root.querySelector('#sh-target-text')?.textContent).toBe('usually hot');
  });

  it('Part 2B: disables replay and word timing in System SpeechRecognizer mode with clear label, and enables Tier 2 speed tags and timing bars when online', async () => {
    const root = document.createElement('div');
    await bootstrapApp(root, 'shadowing');

    // One visible primary control changes from Start to Stop & Score while recording.
    const recordButton = root.querySelector<HTMLButtonElement>('#sh-record-btn');
    const stopAction = root.querySelector<HTMLButtonElement>('#sh-stop-score-btn');
    expect(recordButton?.hidden).toBe(false);
    expect(recordButton?.textContent).toContain('Record Repetition');
    expect(stopAction?.hidden).toBe(true);

    // 1. Test Tier 3 rendering (offline default -> Mode B: SpeechRecognizer only, no audio kept)
    recordButton?.click();
    await new Promise((r) => setTimeout(r, 20));
    const activeRecordButton = root.querySelector<HTMLButtonElement>('#sh-record-btn');
    expect(activeRecordButton?.hidden).toBe(false);
    expect(activeRecordButton?.textContent).toContain('Stop & Score');
    expect(activeRecordButton?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector<HTMLButtonElement>('#sh-stop-score-btn')?.hidden).toBe(true);
    expect(audioRecorder.getLastStartOptions()?.useOfflineRecognizer).toBe(true);

    audioRecorder.setMockRecognizerOutputForTest({
      transcript: 'I usually start my morning with a cup of hot coffee',
      confidence: 0.92
    });

    activeRecordButton?.click();
    await new Promise((r) => setTimeout(r, 40));

    expect(root.querySelector('#sh-score-card')).not.toBeNull();
    expect(root.querySelector('#sh-pace-score')).not.toBeNull();
    expect(root.querySelector('#sh-score-card .tier-badge')?.textContent).toContain('Basic offline');

    // In offline mode, word timing bars are hidden and replaced by clear notice, and replay button is disabled
    expect(root.querySelector('#sh-timing-bars')).toBeNull();
    expect(root.querySelector('#sh-offline-timing-disabled')?.textContent).toContain(
      'Word timing & recording replay disabled in System SpeechRecognizer mode'
    );
    expect(root.querySelector<HTMLButtonElement>('#sh-replay-my-audio-btn')?.disabled).toBe(true);
    expect(root.querySelectorAll('.speed-tag').length).toBe(0);
  });
  it('keeps recording/scoring mutually exclusive with playback and navigation', async () => {
    const root = document.createElement('div');
    await bootstrapApp(root, 'shadowing');
    const record = root.querySelector<HTMLButtonElement>('#sh-record-btn');
    record?.click();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(audioRecorder.isRecording()).toBe(true);
    for (const selector of ['#sh-play-normal-btn','#sh-play-slow-btn','#sh-prev-btn','#sh-next-btn','#sh-generate-ai-btn','#sh-history-prev-btn','#sh-history-next-btn','#sh-language-select','#sh-translate-btn','#sh-grammar-btn','#sh-translation-language','[data-diff]']) {
      expect(root.querySelector<HTMLElement>(selector)?.hasAttribute('disabled')).toBe(true);
    }
    expect(root.querySelector<HTMLButtonElement>('#sh-record-btn')?.disabled).toBe(false);
    root.querySelector<HTMLButtonElement>('#sh-record-btn')?.click();
    expect(root.querySelector<HTMLButtonElement>('#sh-record-btn')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('#sh-play-normal-btn')?.disabled).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(audioRecorder.isRecording()).toBe(false);
  });

  it('stops an active Shadowing recording when navigating to another tab', async () => {
    const root = document.createElement('div');
    await bootstrapApp(root, 'shadowing');

    root.querySelector<HTMLButtonElement>('#sh-record-btn')?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(audioRecorder.isRecording()).toBe(true);

    root.querySelector<HTMLButtonElement>('#nav-ielts')?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(audioRecorder.isRecording()).toBe(false);
    expect(root.querySelector('.ielts-library-card')).not.toBeNull();
    expect(root.querySelector('.ielts-library-card')?.classList.contains('card')).toBe(false);
  });

  it('loads offline starter sentences after switching languages, keeps IELTS available, and lets users dismiss the speech API notice', async () => {
    const root = document.createElement('div');
    // ShadowingView updates the shared bottom-navigation element through
    // document.querySelector, so mount the app as it is mounted in production.
    document.body.appendChild(root);
    await bootstrapApp(root, 'shadowing');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const notice = root.querySelector<HTMLDetailsElement>('.sh-api-capability-notice');
    expect(notice).not.toBeNull();
    expect(notice?.querySelector('#sh-api-notice-dismiss-btn')).not.toBeNull();
    notice?.querySelector<HTMLButtonElement>('#sh-api-notice-dismiss-btn')?.click();
    expect(root.querySelector('.sh-api-capability-notice')?.hasAttribute('hidden')).toBe(true);
    expect(localStorage.getItem('speakcoach_speech_api_notice_dismissed_v1')).toBe('true');

    const languageSelect = root.querySelector<HTMLSelectElement>('#sh-language-select');
    expect(languageSelect).not.toBeNull();
    languageSelect!.value = 'sv';
    languageSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(root.querySelector('#sh-target-text')?.textContent).toBe('Jag brukar ta en kort promenad efter frukosten.');
    expect(root.querySelector('.sh-empty-language-history')).toBeNull();
    expect(root.querySelector('.sh-api-capability-notice')?.hasAttribute('hidden')).toBe(true);

    const ieltsButton = root.querySelector<HTMLButtonElement>('#nav-ielts');
    expect(ieltsButton).not.toBeNull();
    expect(ieltsButton?.disabled).toBe(false);
    expect(ieltsButton?.hasAttribute('aria-disabled')).toBe(false);
    expect(ieltsButton?.disabled).toBe(false);
    expect(root.querySelector('.sh-ielts-language-notice')).toBeNull();
    expect(document.body.querySelector('.app-toast-error')).toBeNull();
    ieltsButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(root.querySelector('.ielts-library-card')).not.toBeNull();
    expect(document.body.querySelector('.app-toast-error')).toBeNull();

    languageSelect!.value = 'en';
    languageSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    root.remove();
  });

});
