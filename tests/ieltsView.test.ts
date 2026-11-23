import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderIeltsView } from '../src/ui/IeltsView';
import { ieltsSessionEngine } from '../src/services/ieltsSessionEngine';
import { audioRecorder } from '../src/services/audioRecorder';
import { clearIeltsDraft, saveIeltsDraft } from '../src/storage/ieltsHistoryStore';
import { generateIeltsSessionPlan } from './fixtures/legacyIeltsQuestionBank';
import { getActiveSlotRuntimeFailure, type GlobalTierSummary } from '../src/services/tierManager';
import * as ttsService from '../src/services/ttsService';

const mockGlobalTierSummary: GlobalTierSummary = {
  isOnlineNetwork: true,
  onlineSlotsCount: 0,
  totalSlotsCount: 6,
  label: 'Basic offline',
  slots: {
    voice_tts: { slotId: 'voice_tts', providerId: 'native_tts', providerName: 'Native Android TTS', tier: 3, label: 'Basic offline', detailLabel: 'Native offline', isFallback: false },
    ielts_stt: { slotId: 'ielts_stt', providerId: 'native_stt', providerName: 'Native Android STT', tier: 3, label: 'Basic offline', detailLabel: 'Native offline', isFallback: false },
    pronunciation_scoring: { slotId: 'pronunciation_scoring', providerId: 'offline_rule_based', providerName: 'Rule-based scorer', tier: 3, label: 'Basic offline', detailLabel: 'Offline', isFallback: false },
    llm_evaluator: { slotId: 'llm_evaluator', providerId: 'offline_ielts_heuristics', providerName: 'Offline IELTS Heuristics', tier: 3, label: 'Basic offline', detailLabel: 'Offline heuristics', isFallback: false },
    llm_generator: { slotId: 'llm_generator', providerId: 'offline_static_bank', providerName: 'Built-in Bank', tier: 3, label: 'Basic offline', detailLabel: 'Offline bank', isFallback: false },
    llm_translation: { slotId: 'llm_translation', providerId: 'offline_translation', providerName: 'Translation unavailable offline', tier: 3, label: 'Basic offline', detailLabel: 'No offline translation', isFallback: false }
  }
};


function seedQuestionSet(): void {
  const plan = generateIeltsSessionPlan({ preferUnseen: false });
  plan.id = 'session_llm_test_fixture';
  plan.part1Questions = plan.part1Questions.map((q) => ({ ...q, id: `llm_${q.id}` }));
  plan.part2CueCard = { ...plan.part2CueCard, id: `llm_${plan.part2CueCard.id}` };
  plan.part3Questions = plan.part3Questions.map((q) => ({ ...q, id: `llm_${q.id}` }));
  localStorage.setItem('speakcoach_ielts_question_sets_v1', JSON.stringify([{
    id: plan.id,
    title: plan.part1Questions[0]?.question || 'IELTS Speaking Set',
    plan,
    status: 'new',
    createdAt: Date.now()
  }]));
}

function startQuestionSet(container: HTMLElement, mode: 'part1' | 'part2' | 'part3' | 'full' = 'part1'): void {
  const modeSelect = container.querySelector<HTMLSelectElement>('#ielts-set-mode');
  if (modeSelect) {
    const modeButton = container.querySelector<HTMLButtonElement>(`[data-mode-choice="${mode}"]`);
    if (modeButton) modeButton.click();
    else modeSelect.value = mode;
  }
  container.querySelector<HTMLButtonElement>('[data-start-set]')?.click();
}

describe('IeltsView UI Component (Question Set Library)', () => {
  let container: HTMLElement;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    localStorage.clear();
    seedQuestionSet();
    ieltsSessionEngine.cancelSession();
    await clearIeltsDraft();
  });

  it('renders a contained empty state with a direct Settings action when no AI question sets exist', () => {
    localStorage.setItem('speakcoach_ielts_question_sets_v1', JSON.stringify([]));
    const onOpenSettings = vi.fn();
    const cleanup = renderIeltsView(container, mockGlobalTierSummary, {
      onComplete: vi.fn(),
      onViewHistory: vi.fn(),
      onOpenSettings
    });
    const emptyState = container.querySelector<HTMLElement>('.ielts-library-empty');
    expect(emptyState).not.toBeNull();
    expect(emptyState?.textContent).toContain('Connect and successfully test');
    expect(emptyState?.textContent).toContain('Get new question sets');
    container.querySelector<HTMLButtonElement>('#ielts-empty-settings-btn')?.click();
    expect(onOpenSettings).toHaveBeenCalledOnce();
    cleanup();
  });

  it('shows an explicit AI connection error when question generation is requested offline', () => {
    localStorage.setItem('speakcoach_ielts_question_sets_v1', JSON.stringify([]));
    const cleanup = renderIeltsView(container, mockGlobalTierSummary, {
      onComplete: vi.fn(),
      onViewHistory: vi.fn()
    });

    container.querySelector<HTMLButtonElement>('#ielts-refresh-sets-btn')?.click();

    const notice = container.querySelector<HTMLElement>('#ielts-set-notice');
    const emptyState = container.querySelector<HTMLElement>('#ielts-library-empty');
    expect(notice?.textContent).toContain('AI is not connected');
    expect(notice?.hidden).toBe(false);
    expect(notice?.parentElement?.classList.contains('ielts-topic-field')).toBe(true);
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(emptyState?.classList.contains('needs-ai-connection')).toBe(true);

    cleanup();
  });

  it('renders mode selection cards and view history button when idle', () => {
    const onComplete = vi.fn();
    const onViewHistory = vi.fn();
    const onOpenSettings = vi.fn();

    const cleanup = renderIeltsView(container, mockGlobalTierSummary, { onComplete, onViewHistory, onOpenSettings });

    expect(container.innerHTML).toContain('Question sets');
    expect(container.querySelector('.ielts-library-card')?.classList.contains('card')).toBe(false);
    expect(container.querySelector('.page-heading h1')?.textContent).toBe('IELTS Speaking');
    expect(container.querySelector('[aria-label="Built-in question quality notice"]')).toBeNull();
    const evaluationNotice = container.querySelector('[aria-label="Offline evaluation quality notice"]');
    const transcriptionNotice = container.querySelector<HTMLDetailsElement>('[aria-label="Offline transcription accuracy notice"]');
    expect(evaluationNotice).toBeNull();
    expect(transcriptionNotice).not.toBeNull();
    expect(transcriptionNotice?.open).toBe(false);
    expect(container.querySelectorAll('.offline-quality-learn-more')).toHaveLength(1);
    expect(container.textContent).toContain('An AI API is required for IELTS evaluation');
    expect(container.textContent).not.toContain('A calm space to practise with your saved speaking sets');
    expect(container.querySelectorAll('.ielts-set-row')).toHaveLength(1);
    expect(container.querySelectorAll('.ielts-set-start.btn-primary')).toHaveLength(1);
    expect(container.innerHTML).toContain('Get new question sets');
    const libraryActions = container.querySelector('.ielts-library-actions');
    const generationSheet = libraryActions?.querySelector<HTMLDetailsElement>('.ielts-generation-sheet');
    expect(generationSheet).not.toBeNull();
    expect(generationSheet?.open).toBe(false);
    expect(generationSheet?.querySelectorAll('button')).toHaveLength(3);
    expect(generationSheet?.querySelector('#ielts-restore-sets-btn')).not.toBeNull();
    expect(generationSheet?.querySelector('#ielts-random-topic-btn')).not.toBeNull();
    expect(generationSheet?.querySelector('#ielts-refresh-sets-btn')).not.toBeNull();
    const topicInput = container.querySelector<HTMLInputElement>('#ielts-topic-input');
    expect(topicInput?.placeholder).toBe('Leave blank for fully random topics.');
    expect(container.querySelector('#ielts-random-topic-btn')?.textContent).toContain('Random topic');
    expect(container.querySelector('#ielts-refresh-sets-btn')?.textContent).toContain('Get new question sets');
    expect(container.querySelector('#ielts-random-topic-btn')?.parentElement?.classList.contains('ielts-topic-input-row')).toBe(true);
    expect(container.querySelector('#ielts-set-mode')).not.toBeNull();
    container.querySelector<HTMLButtonElement>('[data-mode-choice="part2"]')?.click();
    expect(container.querySelector<HTMLSelectElement>('#ielts-set-mode')?.value).toBe('part2');

    // Click history button
    const historyBtn = container.querySelector<HTMLButtonElement>('#ielts-history-btn');
    expect(historyBtn).not.toBeNull();
    historyBtn?.click();
    expect(onViewHistory).toHaveBeenCalled();

    cleanup();
  });

  it('does not show legacy built-in question sets in the active library', () => {
    const legacyPlan = generateIeltsSessionPlan({ preferUnseen: false });
    localStorage.setItem('speakcoach_ielts_question_sets_v1', JSON.stringify([{
      id: legacyPlan.id,
      title: 'Legacy offline set',
      plan: legacyPlan,
      status: 'new',
      createdAt: Date.now()
    }]));
    const cleanup = renderIeltsView(container, mockGlobalTierSummary, {
      onComplete: vi.fn(),
      onViewHistory: vi.fn()
    });
    expect(container.querySelectorAll('.ielts-set-row')).toHaveLength(0);
    expect(container.querySelector('.ielts-library-empty')).not.toBeNull();
    cleanup();
  });

  it('keeps completed question sets out of the active library and counts them as history only', () => {
    const existing = JSON.parse(localStorage.getItem('speakcoach_ielts_question_sets_v1') || '[]');
    const completedPlan = generateIeltsSessionPlan({ preferUnseen: false });
    completedPlan.id = 'completed-session-fixture';
    localStorage.setItem('speakcoach_ielts_question_sets_v1', JSON.stringify([
      ...existing,
      {
        id: completedPlan.id,
        title: 'Completed fixture — must stay in history',
        plan: completedPlan,
        status: 'completed',
        createdAt: Date.now()
      }
    ]));

    const cleanup = renderIeltsView(container, mockGlobalTierSummary, {
      onComplete: vi.fn(),
      onViewHistory: vi.fn()
    });

    expect(container.querySelectorAll('.ielts-set-row')).toHaveLength(1);
    expect(container.textContent).toContain('1 available · 1 completed in history');
    expect(container.textContent).not.toContain('Completed fixture — must stay in history');

    cleanup();
  });

  it('displays draft recovery banner when an active draft is present in storage', async () => {
    const plan = generateIeltsSessionPlan();
    await saveIeltsDraft({
      mode: 'part2',
      plan,
      currentStepIndex: 0,
      candidateNotes: 'Notes test',
      completedAnswers: [],
      updatedAt: Date.now()
    });

    const cleanup = renderIeltsView(container, mockGlobalTierSummary, {
      onComplete: vi.fn(),
      onViewHistory: vi.fn()
    });

    // Wait for async loadIeltsDraft to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));

    const banner = container.querySelector<HTMLElement>('#ielts-draft-banner');
    expect(banner).not.toBeNull();
    expect(banner?.style.display).not.toBe('none');
    expect(container.innerHTML.toLowerCase()).toContain('a saved session is waiting');

    cleanup();
  });

  it('keeps examiner question text hidden until the user reveals it for that question', async () => {
    const cleanup = renderIeltsView(container, mockGlobalTierSummary, {
      onComplete: vi.fn(),
      onViewHistory: vi.fn()
    });
    startQuestionSet(container, 'part1');

    await vi.waitFor(() => expect(ieltsSessionEngine.getState().status).not.toBe('preparing'));
    await vi.waitFor(() => expect(container.querySelector('.ielts-question-text-disclosure')).not.toBeNull());

    const disclosure = container.querySelector<HTMLDetailsElement>('.ielts-question-text-disclosure');
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.querySelector('summary')?.textContent).toContain('Show question text');
    expect(disclosure?.querySelector('.ielts-question-text')?.textContent?.trim()).toBeTruthy();
    expect(container.querySelector('#ielts-question-source-label')?.textContent).toContain('AI question');
    disclosure?.querySelector('summary')?.click();
    expect(disclosure?.open).toBe(true);

    cleanup();
  });

  it('interacts with engine when starting Part 2 and renders prep UI with notes textarea', async () => {
    const cleanup = renderIeltsView(container, mockGlobalTierSummary, {
      onComplete: vi.fn(),
      onViewHistory: vi.fn()
    });

    startQuestionSet(container, 'part2');

    await vi.waitFor(() => expect(ieltsSessionEngine.getState().status).not.toBe('preparing'));
    const state = ieltsSessionEngine.getState();
    expect(state.mode).toBe('part2');
    expect(state.status).not.toBe('idle');
    expect(container.querySelector('.ielts-source-ai')).not.toBeNull();
    expect(container.querySelector('.ielts-builtin-warning')).toBeNull();
    expect(container.querySelector('.ielts-cue-card')).not.toBeNull();
    const progress = container.querySelector<HTMLElement>('.ielts-progress-track[role="progressbar"]');
    expect(progress).not.toBeNull();
    expect(Number(progress?.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    expect(Number(progress?.getAttribute('aria-valuemax'))).toBeGreaterThan(0);
    expect(container.querySelector('.ielts-question-text')).toBeNull();
    expect(container.querySelector('[aria-label="Offline evaluation quality notice"]')).toBeNull();
    expect(container.querySelector('[aria-label="Offline transcription accuracy notice"]')).toBeNull();

    // Check that quit button is present
    const quitBtn = container.querySelector<HTMLButtonElement>('#ielts-cancel-test-btn');
    expect(quitBtn).not.toBeNull();

    cleanup();
  });

  it('renders explicit error screen with Retry and Quit buttons when recording fails and never silently exits', async () => {
    vi.spyOn(audioRecorder, 'start').mockRejectedValue(new Error('Permission denied by user'));

    const cleanup = renderIeltsView(container, mockGlobalTierSummary, {
      onComplete: vi.fn(),
      onViewHistory: vi.fn()
    });

    startQuestionSet(container, 'part1');

    // Allow async examiner prompt -> recording start attempt to process
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Ensure error screen is displayed
    expect(container.innerHTML).toContain('Test session paused');
    expect(container.innerHTML).toContain('Permission denied by user');

    const retryBtn = container.querySelector<HTMLButtonElement>('#ielts-retry-step-btn');
    const quitBtn = container.querySelector<HTMLButtonElement>('#ielts-error-quit-btn');
    expect(retryBtn).not.toBeNull();
    expect(quitBtn).not.toBeNull();

    // Clicking quit cancels session
    quitBtn?.click();
    expect(ieltsSessionEngine.getState().status).toBe('idle');

    cleanup();
  });

  it('shows the library refresh action that replaces pending sets', () => {
    const cleanup = renderIeltsView(container, mockGlobalTierSummary, {
      onComplete: vi.fn(),
      onViewHistory: vi.fn()
    });

    const refreshBtn = container.querySelector<HTMLButtonElement>('#ielts-refresh-sets-btn');
    expect(refreshBtn).not.toBeNull();
    expect(refreshBtn?.textContent).toContain('Get new question sets');
    expect(container.querySelectorAll('[data-start-set]')).toHaveLength(1);

    cleanup();
  });

  it('does not offer question replacement during an active IELTS question', async () => {
    const cleanup = renderIeltsView(container, mockGlobalTierSummary, {
      onComplete: vi.fn(),
      onViewHistory: vi.fn()
    });

    startQuestionSet(container, 'part1');

    await vi.waitFor(() => expect(ieltsSessionEngine.getState().status).not.toBe('preparing'));
    expect(container.querySelector('#ielts-skip-new-question-btn')).toBeNull();
    expect(container.querySelector('.ielts-skip-row')).toBeNull();

    cleanup();
  });

  it('runs non-blocking pre-test deep test when evaluator is online and shows warning banner on failure', async () => {
    const onlineSummary: GlobalTierSummary = {
      isOnlineNetwork: true,
      onlineSlotsCount: 1,
      totalSlotsCount: 6,
      label: 'Online AI',
      slots: {
        ...mockGlobalTierSummary.slots,
        llm_evaluator: {
          slotId: 'llm_evaluator',
          providerId: 'openai_compat_eval',
          providerName: 'OpenAI Evaluator',
          tier: 1,
          label: 'Online AI',
          detailLabel: 'Online AI (Tier 1)',
          isFallback: false
        }
      }
    };

    const onOpenSettings = vi.fn();
    const cleanup = renderIeltsView(container, onlineSummary, {
      onComplete: vi.fn(),
      onViewHistory: vi.fn(),
      onOpenSettings
    });

    // Wait for the async pre-test check to finish (default slot has no key stored, so it will fail)
    await new Promise((resolve) => setTimeout(resolve, 80));

    const warningBanner = container.querySelector<HTMLElement>('#ielts-eval-warning-banner');
    expect(warningBanner).not.toBeNull();
    expect(warningBanner?.style.display).not.toBe('none');
    expect(container.innerHTML.toLowerCase()).toContain('evaluator connection warning');
    expect(container.innerHTML).toContain('API key is empty');
    expect(warningBanner?.classList.contains('ielts-evaluator-chip')).toBe(true);
    expect(warningBanner?.classList.contains('status-box')).toBe(false);
    container.querySelector<HTMLButtonElement>('#ielts-open-settings-btn')?.click();
    expect(onOpenSettings).toHaveBeenCalled();

    // A2-5: Failed pre-test background check must NOT record a runtime failure on llm_evaluator
    expect(getActiveSlotRuntimeFailure('llm_evaluator')).toBeNull();

    // Starting a test is still allowed and not blocked
    startQuestionSet(container, 'part1');
    expect(ieltsSessionEngine.getState().status).not.toBe('idle');

    cleanup();
  });

  it('resumes an interrupted session via restoreSession without wiping saved answers (A2-1: answer 2 questions, simulate restart, resume, 2 answers preserved)', async () => {
    // 1. Start a Part 1 session and answer 2 questions
    const aiPlan = JSON.parse(localStorage.getItem('speakcoach_ielts_question_sets_v1') || '[]')[0].plan;
    await ieltsSessionEngine.startSession('part1', { plan: aiPlan });
    await new Promise((r) => setTimeout(r, 30));

    const firstQId = ieltsSessionEngine.getState().currentStep?.questionId;
    audioRecorder.setMockRecognizerOutputForTest({
      transcript: 'First answer about my hometown and neighborhood.',
      confidence: 0.91
    });
    await ieltsSessionEngine.finishCurrentAnswer();

    const secondQId = ieltsSessionEngine.getState().currentStep?.questionId;
    audioRecorder.setMockRecognizerOutputForTest({
      transcript: 'Second answer about my daily work routine.',
      confidence: 0.89
    });
    await ieltsSessionEngine.finishCurrentAnswer();

    const thirdQIdBeforeRestart = ieltsSessionEngine.getState().currentStep?.questionId;
    expect(ieltsSessionEngine.getState().completedAnswers).toHaveLength(2);
    expect(ieltsSessionEngine.getState().currentStepIndex).toBe(2);

    // 2. Simulate app restart (engine reset to idle, but draft remains in storage)
    ieltsSessionEngine.reset();
    expect(ieltsSessionEngine.getState().status).toBe('idle');
    expect(ieltsSessionEngine.getState().completedAnswers).toHaveLength(0);

    // 3. Render IeltsView and click "Resume Session"
    const cleanup = renderIeltsView(container, mockGlobalTierSummary, {
      onComplete: vi.fn(),
      onViewHistory: vi.fn()
    });

    await new Promise((r) => setTimeout(r, 50));

    const resumeBtn = container.querySelector<HTMLButtonElement>('#ielts-resume-btn');
    expect(resumeBtn).not.toBeNull();
    resumeBtn?.click();

    await new Promise((r) => setTimeout(r, 40));

    // 4. Verify the 2 answers are preserved and session continues from question 3 (stepIndex 2)
    const resumedState = ieltsSessionEngine.getState();
    expect(resumedState.completedAnswers).toHaveLength(2);
    expect(resumedState.completedAnswers[0].questionId).toBe(firstQId);
    expect(resumedState.completedAnswers[0].transcript).toBe(
      'First answer about my hometown and neighborhood.'
    );
    expect(resumedState.completedAnswers[1].questionId).toBe(secondQId);
    expect(resumedState.completedAnswers[1].transcript).toBe(
      'Second answer about my daily work routine.'
    );
    expect(resumedState.currentStepIndex).toBe(2);
    expect(resumedState.currentStep?.questionId).toBe(thirdQIdBeforeRestart);
    expect(resumedState.status).not.toBe('idle');

    cleanup();
  });

  it('updates only the timer text during Part 2 prep countdown and typing without replacing the notes textarea or losing focus/cursor (A2-13)', async () => {
    vi.useFakeTimers();
    try {
      const cleanup = renderIeltsView(container, mockGlobalTierSummary, {
        onComplete: vi.fn(),
        onViewHistory: vi.fn()
      });

      startQuestionSet(container, 'part2');

      await vi.waitFor(() => expect(ieltsSessionEngine.getState().status).toBe('prep_countdown'));

      const notesBefore = container.querySelector<HTMLTextAreaElement>('#ielts-prep-notes');
      const clockBefore = container.querySelector<HTMLElement>('.ielts-timer-clock');
      expect(notesBefore).not.toBeNull();
      expect(clockBefore?.textContent).toBe('01:00');

      // Focus textarea, type content, and place cursor in the middle
      notesBefore!.focus();
      notesBefore!.value = 'My childhood trip to the mountains';
      notesBefore!.setSelectionRange(12, 12);
      notesBefore!.dispatchEvent(new Event('input', { bubbles: true }));

      expect(document.activeElement).toBe(notesBefore);
      expect(notesBefore!.selectionStart).toBe(12);
      expect(ieltsSessionEngine.getState().candidateNotes).toBe('My childhood trip to the mountains');

      // Advance 3 seconds of prep countdown
      vi.advanceTimersByTime(3000);

      const notesAfter = container.querySelector<HTMLTextAreaElement>('#ielts-prep-notes');
      const clockAfter = container.querySelector<HTMLElement>('.ielts-timer-clock');

      // Timer text updated in place
      expect(clockAfter?.textContent).toBe('00:57');
      // Exact same textarea DOM node, still focused, cursor & content untouched
      expect(notesAfter).toBe(notesBefore);
      expect(document.activeElement).toBe(notesBefore);
      expect(notesAfter!.value).toBe('My childhood trip to the mountains');
      expect(notesAfter!.selectionStart).toBe(12);
      expect(notesAfter!.selectionEnd).toBe(12);

      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops all audio and cancels active session when cleanup is called on navigation', async () => {
    const stopSpy = vi.spyOn(ttsService, 'stopAllTts');
    const cleanup = renderIeltsView(container, mockGlobalTierSummary, {
      onComplete: vi.fn(),
      onViewHistory: vi.fn()
    });

    startQuestionSet(container, 'part1');

    await vi.waitFor(() => {
      expect(ieltsSessionEngine.getState().status).not.toBe('preparing');
      expect(ieltsSessionEngine.getState().status).not.toBe('idle');
    });

    // Simulate navigation away from IELTS view by calling cleanup
    cleanup();

    expect(stopSpy).toHaveBeenCalled();
    expect(ieltsSessionEngine.getState().status).toBe('idle');
  });

  it('does not show quit button or completion actions while evaluation is in progress', async () => {
    const cleanup = renderIeltsView(container, mockGlobalTierSummary, {
      onComplete: vi.fn(),
      onViewHistory: vi.fn()
    });

    // Start a test and force evaluating state on engine
    const aiPlan = JSON.parse(localStorage.getItem('speakcoach_ielts_question_sets_v1') || '[]')[0].plan;
    await ieltsSessionEngine.startSession('part1', { plan: aiPlan });
    // @ts-expect-error accessing private method for state simulation
    ieltsSessionEngine.setStatus('evaluating', null, 'Testing evaluation state display');

    expect(ieltsSessionEngine.getState().status).toBe('evaluating');
    expect(container.innerHTML).toContain('Evaluating your test');
    expect(container.querySelector('#ielts-cancel-test-btn')).toBeNull();
    expect(container.querySelector('#result-retake-btn')).toBeNull();
    expect(container.querySelector('#result-menu-btn')).toBeNull();

    cleanup();
    ieltsSessionEngine.reset();
  });
});
