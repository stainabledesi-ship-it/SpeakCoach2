import {
  ieltsSessionEngine,
  type IeltsTestMode,
  type IeltsSessionStateSnapshot
} from '../services/ieltsSessionEngine';
import type { IeltsSessionDraft, IeltsTestRecord } from '../storage/ieltsHistoryStore';
import {
  loadIeltsDraft,
  clearIeltsDraft,
  saveIeltsTestResult,
  getIeltsTestResult
} from '../storage/ieltsHistoryStore';
import { loadAllSlotsConfig } from '../storage/localStore';
import { testSlotConnection } from '../services/connectionTester';
import type { GlobalTierSummary } from '../services/tierManager';
import { stopAllTts } from '../services/ttsService';
import { generateIeltsQuestionSets } from '../services/ieltsQuestionGenerator';
import { compareIeltsAttempts } from '../services/ieltsLlmEvaluator';
import { getIeltsQuestionSets, markIeltsQuestionSetCompleted, getPreviousIeltsQuestionSetGenerationCount, restorePreviousIeltsQuestionSets } from '../services/ieltsQuestionSetStore';
import { confirmInApp } from './confirmDialog';

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
}

const IELTS_RANDOM_TOPICS = [
  'Technology and everyday life', 'Education and lifelong learning', 'The environment and sustainability',
  'Work and changing careers', 'Cities and public spaces', 'Culture and traditions',
  'Health and wellbeing', 'Art and creativity', 'Communication and relationships',
  'Travel and cultural exchange', 'Food and consumer habits', 'Science and innovation',
  'Community life', 'Transport and mobility', 'Media and entertainment',
  'Nature and wildlife', 'Money and personal choices', 'History and heritage',
  'Sports and leisure', 'Social change and future generations'
];

export interface IeltsViewCallbacks {
  onComplete: (record: IeltsTestRecord) => void;
  onViewHistory: () => void;
  onOpenSettings?: () => void;
}

export function renderIeltsView(
  container: HTMLElement,
  summary: GlobalTierSummary,
  callbacks: IeltsViewCallbacks
): () => void {
  let draftChecked = false;
  let activeDraft: IeltsSessionDraft | null = null;
  let handledCompletedSessionId: string | null = null;
  let isRegeneratingQuestions = false;
  let requestedTopicInput = '';
  let preTestCheckDone = false;
  let evaluatorWarningText: string | null = null;
  let lastRenderedViewKey: string | null = null;

  /** Keep source provenance visible without exposing provider configuration during the exam. */
  function renderSourceChip(state: IeltsSessionStateSnapshot): string {
    if (state.questionSource === 'AI') {
      return `<span
        id="ielts-question-source-label"
        class="ielts-source-chip ielts-source-ai"
        title="AI-generated IELTS question"
        aria-label="Question source: AI-generated">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/><circle cx="12" cy="12" r="5"/></svg>
        <span>AI question</span>
      </span>`;
    }
    return `<span
      id="ielts-question-source-label"
      class="ielts-source-chip ielts-source-bank"
      title="Saved question set"
      aria-label="Question source: saved question">
      <span>Saved question</span>
    </span>`;
  }

  function formatTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  function render(state: IeltsSessionStateSnapshot): void {
    const currentViewKey = `${state.sessionId}:${state.status}:${state.currentStepIndex}:${state.currentStep?.questionId ?? ''}`;

    // In-place timer update during countdowns so we never destroy DOM, focus, or cursor position (A2-13)
    if (lastRenderedViewKey === currentViewKey) {
      if (state.status === 'prep_countdown') {
        const clockEl = container.querySelector<HTMLElement>('.ielts-timer-clock');
        const notesEl = container.querySelector<HTMLTextAreaElement>('#ielts-prep-notes');
        if (clockEl && notesEl) {
          clockEl.textContent = formatTime(state.prepSecondsRemaining);
          return;
        }
      } else if (state.status === 'recording') {
        if (state.currentStep?.part !== 2) {
          const countdownEl = container.querySelector<HTMLElement>('.ielts-final-countdown');
          if (countdownEl) {
            countdownEl.textContent = String(Math.max(0, state.talkSecondsRemaining));
            countdownEl.hidden = state.talkSecondsRemaining > 10;
            return;
          }
        } else {
          const clockEl = container.querySelector<HTMLElement>('.ielts-timer-clock');
          if (clockEl) {
            clockEl.textContent = formatTime(state.talkSecondsRemaining);
            return;
          }
        }
      }
    }
    lastRenderedViewKey = currentViewKey;

    if (state.status === 'completed') {
      if (handledCompletedSessionId === state.sessionId) {
        return;
      }
      handledCompletedSessionId = state.sessionId;

      // Completed - save record (with evaluation if successful, or null if failed)
      container.innerHTML = `<section class="card ielts-saving-state" role="status" aria-live="polite"><div class="ielts-state-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div><h2 class="card-title ielts-state-title">Saving your IELTS result...</h2><p class="card-subtitle ielts-state-copy">If this is a repeated test, the app will also compare your new answers and scores with the previous attempt.</p></section>`;
      const answerSummaries = state.completedAnswers.map((ans) => ({
        questionId: ans.questionId,
        part: (ans.part === 1 ? 'part1' : ans.part === 2 ? 'part2' : 'part3') as 'part1' | 'part2' | 'part3',
        questionText: ans.question,
        transcript: ans.transcript,
        durationSec: Math.round(ans.durationMs / 1000),
        wasSkipped: ans.wasSkipped
      }));

      try {
        markIeltsQuestionSetCompleted(state.plan.id);
      } catch (error) {
        // A question-set status write must never prevent the actual test result
        // from being saved to history.
        console.warn('[SpeakCoach] Could not update generated question-set completion status.', error);
      }

      const completedRecordData = {
        id: `${state.sessionId}_attempt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        mode: state.mode,
        plan: state.plan,
        questionSetId: state.plan.id,
        overallBand: state.evaluationResult ? state.evaluationResult.overallBand : null,
        evaluation: state.evaluationResult ?? null,
        evaluationError: state.evaluationError ?? null,
        answers: answerSummaries,
        questionSource: state.questionSource,
        questionSourceDetails: state.questionSourceDetails
      };
      const persistCompletedResult = async (): Promise<void> => {
        try {
          const record = await saveIeltsTestResult(completedRecordData);
          // The primary result must never wait for the optional comparison API.
          ieltsSessionEngine.reset();
          callbacks.onComplete(record);

          if (record.previousAttemptId) {
            void (async () => {
              try {
                const previous = await getIeltsTestResult(record.previousAttemptId!);
                if (!previous) return;
                const comparison = await compareIeltsAttempts(previous, record);
                // Merge into the latest stored record so a concurrent re-evaluation
                // cannot be overwritten by this delayed background response.
                const latestRecord = await getIeltsTestResult(record.id);
                if (!latestRecord) return;
                await saveIeltsTestResult(
                  { ...latestRecord, comparison, comparisonError: null },
                  { clearDraft: false }
                );
              } catch (error) {
                console.warn('[SpeakCoach] IELTS attempt comparison could not be saved.', error);
              }
            })();
          }
        } catch (error) {
          container.innerHTML = `<section class="card ielts-saving-state" role="alert" aria-live="assertive">
            <h2 class="card-title ielts-state-title">Your result could not be saved yet</h2>
            <p class="card-subtitle" id="ielts-save-error"></p>
            <p class="card-subtitle">Your answers are still held in the current session. Check available storage and try again.</p>
            <button type="button" class="btn btn-primary" id="ielts-retry-save-btn">Retry saving result</button>
          </section>`;
          const errorEl = container.querySelector<HTMLElement>('#ielts-save-error');
          if (errorEl) errorEl.textContent = error instanceof Error ? error.message : String(error);
          container.querySelector<HTMLButtonElement>('#ielts-retry-save-btn')?.addEventListener('click', (event) => {
            const button = event.currentTarget as HTMLButtonElement;
            button.disabled = true;
            button.textContent = 'Saving…';
            void persistCompletedResult();
          });
        }
      };
      void persistCompletedResult();
      return;
    }

    if (state.status === 'preparing') {
      container.innerHTML = `
        <section class="card">
          <div class="card-header">
            <div class="ielts-session-heading">${state.mode.toUpperCase()} TEST SESSION</div>
            <button type="button" class="btn btn-secondary ielts-quit-button" id="ielts-cancel-test-btn">Cancel</button>
          </div>
          <div class="ielts-preparing-state" role="status" aria-live="polite">
            <div class="ielts-preparing-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg></div>
            <h2 class="ielts-preparing-title">Preparing your session…</h2>
            <p class="ielts-preparing-copy">Getting your questions ready. This may take a moment; please keep this screen open.</p>
          </div>
        </section>
      `;
      container.querySelector<HTMLButtonElement>('#ielts-cancel-test-btn')?.addEventListener('click', () => {
        void confirmInApp({
          title: 'Cancel this test?',
          message: 'Your answers saved so far will remain available in your session history.',
          confirmLabel: 'Cancel test',
          cancelLabel: 'Keep practising',
          tone: 'danger'
        }).then((confirmed) => {
          if (confirmed) ieltsSessionEngine.cancelSession();
        });
      });
      return;
    }

    if (state.status === 'idle') {
      const allSets = getIeltsQuestionSets();
      // Completed sets live in Test History only; keep the active library limited
      // to the current five pending sets (or fewer if the user has not refreshed).
      const sets = allSets.filter((set) => set.status === 'new' && set.plan.id.includes('llm'));
      const tierBadge = summary.slots.llm_evaluator.label === 'Online AI' ? 'online' : 'offline';
      const setRows = sets.map((set) => `
        <article class="ielts-set-row">
          <div class="ielts-set-copy">
            <div class="ielts-set-title">${escapeHtml(set.title)}</div>
            <div class="ielts-set-meta">${set.plan.part1Questions.length} Part 1 prompts · 1 cue card · ${set.plan.part3Questions.length} Part 3 prompts</div>
          </div>
          
          <button type="button" class="btn btn-primary ielts-set-start" data-start-set="${escapeHtml(set.id)}">Start practice</button>
        </article>
      `).join('');

      container.innerHTML = `
        <div class="ielts-library-page ielts-library-card">
          <div class="page-heading">
            <div class="page-heading-title">
              <h1 class="card-title">IELTS Speaking</h1>
            </div>
            
          </div>

          <div id="ielts-eval-warning-banner" class="ielts-evaluator-chip" style="display:${evaluatorWarningText ? 'flex' : 'none'};">
            <div class="ielts-evaluator-copy">
              <strong>Evaluator connection warning</strong>
              <p id="ielts-eval-warning-text" class="card-subtitle">${escapeHtml(evaluatorWarningText || 'Your answers are saved even if evaluation is unavailable.')}</p>
            </div>
            <button type="button" class="btn btn-secondary" id="ielts-open-settings-btn">Review Settings</button>
          </div>
${summary.slots.llm_evaluator.tier === 3 ? `<div class="status-box info" role="status">An AI API is required for IELTS evaluation. Your answers are saved if evaluation cannot be completed; reconnect and retry from Test History.</div>` : ''}
          ${summary.slots.ielts_stt.tier === 3 ? `<details class="offline-quality-notice" aria-label="Offline transcription accuracy notice">
            <summary><strong>Transcription accuracy notice</strong><span class="offline-quality-learn-more">Learn more</span></summary>
            <p>Answers are currently transcribed with the device's system speech recognizer. Depending on your Android speech service and device settings, it may use online services. Accuracy may vary, especially with accents or background noise; a tested AI speech-to-text provider may offer more consistent results.</p>
          </details>` : ''}

          <div id="ielts-draft-banner" class="ielts-draft-banner" style="${activeDraft ? 'display:block;' : 'display:none;'}">
            <strong class="ielts-draft-title">A saved session is waiting</strong>
            <p class="card-subtitle" id="ielts-draft-text">${activeDraft ? `Saved ${activeDraft.mode.toUpperCase()} session with ${(activeDraft.completedAnswers || []).length} answered question(s).` : ''}</p>
            <div class="btn-row">
              <button type="button" class="btn btn-primary" id="ielts-resume-btn">Resume</button>
              <button type="button" class="btn btn-secondary" id="ielts-discard-draft-btn">Discard</button>
            </div>
          </div>

          <div class="ielts-library-heading">
            <div>
              <h2 class="card-title">Question sets</h2>
              <p class="card-subtitle">${sets.length} available · ${allSets.filter((set) => set.status === 'completed').length} completed in history</p>
            </div>
            <div class="ielts-library-actions">
              <details class="ielts-generation-sheet">
                <summary class="btn btn-secondary">New sets</summary>
                <div class="ielts-generation-sheet-content"><button type="button" class="btn btn-secondary" id="ielts-restore-sets-btn" ${getPreviousIeltsQuestionSetGenerationCount() === 0 || isRegeneratingQuestions ? 'disabled' : ''}>Restore previous sets</button></div>
              </details>
            </div>
          </div>
          <div class="form-field ielts-topic-field">
            <label for="ielts-topic-input" class="form-label">Optional topic for Parts 2 &amp; 3</label>
            <div class="btn-row ielts-topic-input-row">
              <input type="text" class="form-input ielts-topic-input" id="ielts-topic-input" maxlength="100" placeholder="Leave blank for fully random topics." value="${escapeHtml(requestedTopicInput)}" />
              <button type="button" class="btn btn-secondary" id="ielts-random-topic-btn">Random topic</button>
            </div>
            <div class="ielts-topic-generate-action">
              <button type="button" class="btn btn-primary ielts-refresh-btn" id="ielts-refresh-sets-btn" ${isRegeneratingQuestions ? 'disabled' : ''}>${isRegeneratingQuestions ? 'Generating…' : 'Get new question sets'}</button>
            </div>
            <div id="ielts-set-notice" class="ielts-library-notice" role="status" aria-live="polite" hidden></div>
          </div>
          <div class="ielts-set-mode-row">
            <span class="form-label" id="ielts-mode-label">Test mode</span>
            <div class="ielts-mode-control">
              <div class="ielts-mode-segmented" role="radiogroup" aria-labelledby="ielts-mode-label">
                <button type="button" class="active" role="radio" aria-checked="true" tabindex="0" data-mode-choice="full">Full</button>
                <button type="button" role="radio" aria-checked="false" tabindex="-1" data-mode-choice="part1">Part 1</button>
                <button type="button" role="radio" aria-checked="false" tabindex="-1" data-mode-choice="part2">Part 2</button>
                <button type="button" role="radio" aria-checked="false" tabindex="-1" data-mode-choice="part3">Part 3</button>
              </div>
              <select id="ielts-set-mode" class="ielts-mode-select-hidden" aria-hidden="true" tabindex="-1">
                <option value="full">Full test · Parts 1, 2, 3</option>
                <option value="part1">Part 1 only</option>
                <option value="part2">Part 2 only</option>
                <option value="part3">Part 3 only</option>
              </select>
            </div>
          </div>
          <div id="ielts-set-list" class="ielts-set-list">
            ${setRows || '<div class="ielts-library-empty" id="ielts-library-empty" aria-live="polite"><strong>No saved question sets yet</strong><p>Connect and successfully test an AI Question &amp; Sentence Generator in Settings, then tap “Get new question sets” to create your first IELTS practice sets.</p><button type="button" class="btn btn-secondary ielts-empty-settings-btn" id="ielts-empty-settings-btn">Open AI settings</button></div>'}
          </div>
          <button type="button" class="btn btn-secondary ielts-history-link" id="ielts-history-btn">View past results &amp; trends</button>
        </div>
      `;

      if (!preTestCheckDone && summary.slots.llm_evaluator.label === 'Online AI') {
        preTestCheckDone = true;
        loadAllSlotsConfig().then(async (allConfigs) => {
          const testRes = await testSlotConnection(allConfigs.llm_evaluator, { recordRuntimeFailure: false });
          if (!testRes.ok) {
            evaluatorWarningText = `Evaluator pre-test warning (${testRes.message}). Your answers are still saved if evaluation fails.`;
            const warning = container.querySelector<HTMLElement>('#ielts-eval-warning-banner');
            const warningText = container.querySelector<HTMLElement>('#ielts-eval-warning-text');
            if (warning && warningText) { warning.style.display = 'flex'; warningText.textContent = evaluatorWarningText; }
          }
        }).catch(() => {});
      }

      if (!draftChecked) {
        draftChecked = true;
        loadIeltsDraft().then((draft) => {
          if (draft?.plan) {
            activeDraft = draft;
            const banner = container.querySelector<HTMLElement>('#ielts-draft-banner');
            const desc = container.querySelector<HTMLElement>('#ielts-draft-text');
            if (banner && desc) {
              banner.style.display = 'block';
              desc.textContent = `Saved ${draft.mode.toUpperCase()} session with ${(draft.completedAnswers || []).length} answered question(s).`;
            }
          }
        });
      }

      container.querySelector<HTMLButtonElement>('#ielts-open-settings-btn')?.addEventListener('click', () => callbacks.onOpenSettings?.());
      container.querySelector<HTMLButtonElement>('#ielts-empty-settings-btn')?.addEventListener('click', () => callbacks.onOpenSettings?.());

      const modeSelect = container.querySelector<HTMLSelectElement>('#ielts-set-mode');
      const modeButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-mode-choice]'));
      const syncModeButtons = (selectedMode: string): void => {
        modeButtons.forEach((button) => {
          const active = button.dataset.modeChoice === selectedMode;
          button.classList.toggle('active', active);
          button.setAttribute('aria-checked', String(active));
          button.tabIndex = active ? 0 : -1;
        });
      };
      modeButtons.forEach((button, index) => {
        button.addEventListener('click', () => {
          if (modeSelect && button.dataset.modeChoice) modeSelect.value = button.dataset.modeChoice;
          syncModeButtons(button.dataset.modeChoice || 'full');
        });
        button.addEventListener('keydown', (event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const direction = event.key === 'ArrowRight' ? 1 : -1;
          const next = modeButtons[(index + direction + modeButtons.length) % modeButtons.length];
          next?.click();
          next?.focus();
        });
      });
      if (modeSelect) syncModeButtons(modeSelect.value);

      container.querySelectorAll<HTMLButtonElement>('[data-start-set]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const set = getIeltsQuestionSets().find((item) => item.id === btn.dataset.startSet && item.status === 'new');
          if (!set) return;
          const mode = (container.querySelector<HTMLSelectElement>('#ielts-set-mode')?.value || 'full') as IeltsTestMode;
          btn.disabled = true;
          ieltsSessionEngine.startSession(mode, { plan: set.plan }).catch((err: any) => {
            const notice = container.querySelector<HTMLElement>('#ielts-set-notice');
            if (notice) notice.textContent = err?.message || 'Could not start this test set.';
          });
        });
      });

      container.querySelector<HTMLInputElement>('#ielts-topic-input')?.addEventListener('input', event => {
        requestedTopicInput = (event.target as HTMLInputElement).value;
      });

      container.querySelector<HTMLButtonElement>('#ielts-random-topic-btn')?.addEventListener('click', () => {
        const choices = IELTS_RANDOM_TOPICS.filter(topic => topic.toLocaleLowerCase() !== requestedTopicInput.trim().toLocaleLowerCase());
        requestedTopicInput = choices[Math.floor(Math.random() * choices.length)] ?? IELTS_RANDOM_TOPICS[0];
        const input = container.querySelector<HTMLInputElement>('#ielts-topic-input');
        if (input) input.value = requestedTopicInput;
      });

      container.querySelector<HTMLButtonElement>('#ielts-restore-sets-btn')?.addEventListener('click', () => {
        const restored = restorePreviousIeltsQuestionSets();
        render(ieltsSessionEngine.getState());
        const notice = container.querySelector<HTMLElement>('#ielts-set-notice');
        if (notice) {
          notice.textContent = restored?.length
            ? `Restored ${restored.length} previous question sets. The set batch you replaced is now available as the previous generation.`
            : 'No previous question-set generation is available.';
          notice.classList.toggle('error', !restored);
        }
      });

      container.querySelector<HTMLButtonElement>('#ielts-refresh-sets-btn')?.addEventListener('click', async () => {
        if (isRegeneratingQuestions) return;
        const notice = container.querySelector<HTMLElement>('#ielts-set-notice');
        const emptyState = container.querySelector<HTMLElement>('#ielts-library-empty');
        if (summary.slots.llm_generator.label !== 'Online AI') {
          const message = 'AI is not connected. Open AI Settings, configure a provider for “Question & Sentence Generator”, then tap Test API 1.';
          if (notice) {
            notice.hidden = false;
            notice.textContent = message;
            notice.classList.add('error', 'is-visible');
            notice.setAttribute('role', 'alert');
          }
          emptyState?.classList.add('needs-ai-connection');
          emptyState?.setAttribute('aria-label', 'No saved question sets. AI connection required.');
          const emptyTitle = emptyState?.querySelector<HTMLElement>('strong');
          if (emptyTitle) emptyTitle.textContent = 'AI connection required';
          const emptyCopy = emptyState?.querySelector<HTMLElement>('p');
          if (emptyCopy) emptyCopy.textContent = 'Question sets are generated by AI. Connect and successfully test the Question & Sentence Generator in Settings, then try again.';
          return;
        }
        isRegeneratingQuestions = true;
        const button = container.querySelector<HTMLButtonElement>('#ielts-refresh-sets-btn');
        if (button) { button.disabled = true; button.textContent = 'Generating five sets…'; }
        if (notice) { notice.hidden = false; notice.textContent = 'Generating five new AI question sets. Your current unfinished sets will be replaced only after the new batch is saved.'; notice.classList.remove('error', 'is-visible'); }
        try {
          const requestedTopic = requestedTopicInput.trim();
          const added = await generateIeltsQuestionSets(5, { requestedTopic });
          if (notice) notice.textContent = `${added.length} new set(s) ready. Previous unfinished sets were replaced; completed sets remain in history.`;
        } catch (err: any) {
          if (notice) { notice.textContent = err?.message || 'Question generation failed.'; notice.classList.add('error'); }
        } finally {
          const noticeMessage = notice?.textContent ?? '';
          const noticeHasError = notice?.classList.contains('error') ?? false;
          isRegeneratingQuestions = false;
          render(ieltsSessionEngine.getState());
          const refreshedNotice = container.querySelector<HTMLElement>('#ielts-set-notice');
          if (refreshedNotice && noticeMessage) {
            refreshedNotice.hidden = false;
            refreshedNotice.textContent = noticeMessage;
            refreshedNotice.classList.toggle('error', noticeHasError);
            refreshedNotice.classList.toggle('is-visible', noticeHasError);
            const refreshedEmptyState = container.querySelector<HTMLElement>('#ielts-library-empty');
            refreshedEmptyState?.classList.toggle('needs-ai-connection', noticeHasError);
            if (noticeHasError) {
              refreshedEmptyState?.setAttribute('aria-label', 'No saved question sets. AI connection required.');
              const title = refreshedEmptyState?.querySelector<HTMLElement>('strong');
              if (title) title.textContent = 'AI connection required';
              const copy = refreshedEmptyState?.querySelector<HTMLElement>('p');
              if (copy) copy.textContent = 'Question sets are generated by AI. Connect and successfully test the Question & Sentence Generator in Settings, then try again.';
            }
          }
        }
      });

      container.querySelector<HTMLButtonElement>('#ielts-resume-btn')?.addEventListener('click', () => {
        if (activeDraft) {
          ieltsSessionEngine.restoreSession({
            mode: activeDraft.mode, plan: activeDraft.plan,
            currentStepIndex: activeDraft.currentStepIndex,
            completedAnswers: activeDraft.completedAnswers || [],
            candidateNotes: activeDraft.candidateNotes || '',
            autoStartPrompt: true,
            questionSource: activeDraft.questionSource,
            questionSourceDetails: activeDraft.questionSourceDetails
          });
        }
      });
      container.querySelector<HTMLButtonElement>('#ielts-discard-draft-btn')?.addEventListener('click', async () => {
        await clearIeltsDraft(); activeDraft = null;
        const banner = container.querySelector<HTMLElement>('#ielts-draft-banner');
        if (banner) banner.style.display = 'none';
      });
      container.querySelector<HTMLButtonElement>('#ielts-history-btn')?.addEventListener('click', () => callbacks.onViewHistory());
      return;
    }

    // Active session UI
    const totalQ = state.totalSteps || 1;
    const currentQNum = state.currentStepIndex + 1;
    const currentStep = state.currentStep;
    const partLabel = currentStep
      ? currentStep.part === 1
        ? 'Part 1: Interview'
        : currentStep.part === 2
          ? 'Part 2: Long Turn'
          : 'Part 3: Discussion'
      : 'IELTS';

    let contentHtml = '';

    if (state.status === 'error') {
      contentHtml = `
        <div class="ielts-error-state" role="alert">
          <div class="ielts-error-title"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/></svg> Test session paused</div>
          <p class="ielts-error-copy" id="ielts-error-message">
            ${escapeHtml(state.errorMessage || 'An error occurred during this step.')}
          </p>
          <div class="btn-row">
            <button type="button" class="btn btn-primary" id="ielts-retry-step-btn">
              <svg class="ielts-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.2 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 11.8-3"/></svg> Retry this step
            </button>
            <button type="button" class="btn btn-secondary" id="ielts-error-quit-btn">
              Quit test
            </button>
          </div>
        </div>
      `;
    } else if (state.status === 'evaluating') {
      contentHtml = `
        <div class="ielts-processing-state" role="status" aria-live="polite">
          <div class="ielts-state-icon is-animated"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9m5 10V5m5 14v-7m5 7V3"/></svg></div>
          <h2 class="ielts-state-title">Evaluating your test…</h2>
          <p class="ielts-state-copy">
            Analyzing fluency, pauses, grammar accuracy, and vocabulary complexity against IELTS speaking criteria. Pronunciation is reported separately when a supported pronunciation assessment is available.
          </p>
        </div>
      `;
    } else if (state.status === 'transcribing') {
      contentHtml = `
        <div class="ielts-processing-state is-compact" role="status" aria-live="polite">
          <div class="ielts-state-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div>
          <h3 class="ielts-state-title">Transcribing your answer…</h3>
          <p class="ielts-state-copy">Processing audio through speech recognizer</p>
        </div>
      `;
    } else if (state.status === 'unrecognized_prompt') {
      contentHtml = `
        <div class="ielts-unrecognized-state" role="status" aria-live="polite">
          <div class="ielts-state-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6l-5 4H4Zm13-1 4 6m0-6-4 6"/></svg></div>
          <h3 class="ielts-unrecognized-title">
            Nothing was recognized
          </h3>
          <p class="ielts-unrecognized-copy">
            No clear speech was detected. You can record your answer again, or continue without answering this question.
          </p>
          <div class="btn-row ielts-unrecognized-actions">
            <button type="button" class="btn btn-primary" id="ielts-rerecord-btn">
              <svg class="ielts-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v3m-4 0h8"/></svg> Re-record answer
            </button>
            <button type="button" class="btn btn-danger" id="ielts-skip-question-btn">
              <svg class="ielts-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5 5 19"/></svg> Continue without an answer
            </button>
          </div>
        </div>
      `;
    } else {
      // Questions / Recording / Prep UI
      const isPart2 = currentStep?.part === 2;
      let cueCardHtml = '';
      if (isPart2 && (currentStep?.cueCard || currentStep?.canonicalQuestion?.cueCard)) {
        const cueCard = currentStep?.canonicalQuestion?.cueCard || currentStep?.cueCard;
        cueCardHtml = `
          <div class="ielts-cue-card">
            <div class="ielts-cue-card-title">${escapeHtml(String(cueCard?.title || ''))}</div>
            <div class="ielts-cue-card-sub">You should say:</div>
            <ul class="ielts-cue-card-bullets">
              ${(cueCard?.bullets || []).map((b) => `<li>${escapeHtml(String(b))}</li>`).join('')}
            </ul>
          </div>
        `;
      }

      let examinerStatusHtml = '';
      if (state.status === 'examiner_speaking') {
        examinerStatusHtml = `
          <div class="ielts-live-wave" role="status" aria-live="polite">
            <span class="ielts-speaker-indicator" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 10v4h4l5 4V6l-5 4H4Z"/><path class="speaker-wave speaker-wave-one" d="M17 9a5 5 0 0 1 0 6"/><path class="speaker-wave speaker-wave-two" d="M19.5 6.5a9 9 0 0 1 0 11"/></svg></span>
            <span>${state.examinerAudioStarted ? 'Examiner speaking. Please listen carefully.' : 'Please wait for the examiner’s question. Audio will start shortly.'}</span>
          </div>
        `;
      } else if (state.status === 'cue_tone') {
        examinerStatusHtml = `
          <div class="ielts-live-wave is-candidate-turn" role="status" aria-live="polite">
            <span class="ielts-turn-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v3m-4 0h8"/></svg></span>
            <span>Your turn. Speak clearly into the microphone.</span>
          </div>
        `;
      }

      const examinerVoiceNoticeHtml = state.activeVoiceTier
        ? state.activeVoiceTier.tier >= 3
          ? `<div class="status-box info ielts-voice-tier-notice" role="status">Using the basic Android voice. Online TTS was unavailable for this question.${state.activeVoiceTier.reason ? `<p class="card-subtitle">Reason: ${escapeHtml(state.activeVoiceTier.reason)}</p>` : ''}</div>`
          : `<div class="tier-badge online ielts-voice-tier-notice" role="status">Examiner voice ready</div>`
        : '';

      let actionAreaHtml = '';
      if (state.status === 'prep_countdown') {
        actionAreaHtml = `
          <div class="ielts-timer-banner">
            <div>
              <div class="ielts-timer-label">PREPARATION TIME</div>
              <div class="ielts-timer-clock">${formatTime(state.prepSecondsRemaining)}</div>
            </div>
            <button type="button" class="btn btn-primary" id="ielts-skip-prep-btn">
              Start speaking now
            </button>
          </div>
          <div>
            <label class="ielts-notes-label">
              Notes (optional):
            </label>
            <textarea class="ielts-notes-area" id="ielts-prep-notes" placeholder="Jot down keywords, bullet points, or ideas for your 2-minute talk...">${escapeHtml(state.candidateNotes)}</textarea>
          </div>
        `;
      } else if (state.status === 'recording') {
        const isTimedGuidancePart = currentStep?.part === 1 || currentStep?.part === 3;
        const speakingGuidance = currentStep?.part === 1
          ? 'Aim to speak for around 10–20 seconds. Recording stops automatically after 45 seconds, or you can tap Stop whenever you\'re ready.'
          : 'Aim to speak for around 30–60 seconds. Recording stops automatically after 70 seconds, or you can tap Stop whenever you\'re ready.';
        actionAreaHtml = `
          <div class="ielts-timer-banner">
            <div class="ielts-recording-copy">
              <div class="ielts-recording-label">
                <span class="recording-led"></span> Recording in progress
              </div>
              ${isTimedGuidancePart
                ? `<div class="ielts-speaking-guidance-wrap"><p class="ielts-speaking-guidance">${speakingGuidance}</p><div class="ielts-final-countdown" role="timer" aria-live="off" hidden>${Math.max(0, state.talkSecondsRemaining)}</div></div>`
                : `<div class="ielts-timer-clock recording">${formatTime(state.talkSecondsRemaining)}</div>`}
            </div>
            <button type="button" class="btn btn-primary" id="ielts-done-speaking-btn">
              Done speaking
            </button>
          </div>
          ${isPart2 && state.candidateNotes ? `
            <div class="ielts-candidate-notes">
              <strong>Your Notes:</strong>
              <p class="ielts-candidate-notes-copy">${escapeHtml(state.candidateNotes)}</p>
            </div>
          ` : ''}
        `;
      }

      contentHtml = `
        <div class="ielts-question-meta">
          <span class="ielts-badge-part">${partLabel}</span>
          <span class="ielts-question-count">Question ${currentQNum} of ${totalQ}</span>
        </div>
        <div class="ielts-progress-track" role="progressbar" aria-label="Test progress" aria-valuemin="0" aria-valuemax="${totalQ}" aria-valuenow="${currentQNum}">
          <span class="ielts-progress-fill" style="width: ${Math.min(100, Math.max(0, Math.round((currentQNum / totalQ) * 100)))}%"></span>
        </div>
        <div class="ielts-question-area">
${!isPart2
            ? `<details class="ielts-question-text-disclosure">
                <summary>Show question text</summary>
                <div class="ielts-question-text">
                  ${escapeHtml(String(currentStep?.canonicalQuestion?.text || currentStep?.questionText || ''))}
                </div>
              </details>`
            : ''}
          <div class="ielts-source-row">${renderSourceChip(state)}</div>
          ${cueCardHtml}
        </div>
        <div class="ielts-action-area">
          ${examinerStatusHtml}
          ${examinerVoiceNoticeHtml}
          ${actionAreaHtml}
        </div>

      `;
    }

    container.innerHTML = `
      <section class="card ielts-session-card">
        <div class="card-header">
          <div class="ielts-session-heading">
            ${state.mode.toUpperCase()} TEST SESSION
          </div>
          ${state.status !== 'evaluating' ? `
          <button type="button" class="btn btn-secondary ielts-quit-button" id="ielts-cancel-test-btn">
            Quit test
          </button>
          ` : ''}
        </div>
        ${contentHtml}
      </section>
    `;

    // Bind event handlers
    container.querySelector<HTMLButtonElement>('#ielts-cancel-test-btn')?.addEventListener('click', () => {
      void confirmInApp({
        title: 'Quit this test?',
        message: 'Your answers saved so far will remain in the session history. You can return to the question library.',
        confirmLabel: 'Quit test',
        cancelLabel: 'Keep practising',
        tone: 'danger'
      }).then((confirmed) => {
        if (confirmed) ieltsSessionEngine.cancelSession();
      });
    });

    container.querySelector<HTMLButtonElement>('#ielts-skip-prep-btn')?.addEventListener('click', () => {
      ieltsSessionEngine.skipPart2Prep();
    });

    const notesArea = container.querySelector<HTMLTextAreaElement>('#ielts-prep-notes');
    if (notesArea) {
      notesArea.addEventListener('input', () => {
        ieltsSessionEngine.setCandidateNotes(notesArea.value);
      });
    }

    container.querySelector<HTMLButtonElement>('#ielts-retry-step-btn')?.addEventListener('click', () => {
      ieltsSessionEngine.retryCurrentStep().catch(() => {});
    });

    container.querySelector<HTMLButtonElement>('#ielts-error-quit-btn')?.addEventListener('click', () => {
      ieltsSessionEngine.cancelSession();
    });

    container.querySelector<HTMLButtonElement>('#ielts-rerecord-btn')?.addEventListener('click', () => {
      ieltsSessionEngine.reRecordCurrentStep().catch(() => {});
    });

    container.querySelector<HTMLButtonElement>('#ielts-skip-question-btn')?.addEventListener('click', () => {
      ieltsSessionEngine.skipCurrentStep().catch(() => {});
    });

    container.querySelector<HTMLButtonElement>('#ielts-done-speaking-btn')?.addEventListener('click', () => {
      const btn = container.querySelector<HTMLButtonElement>('#ielts-done-speaking-btn');
      if (btn) btn.disabled = true;
      ieltsSessionEngine.stopRecordingEarly().catch(() => {});
    });
  }

  // Subscribe to engine state changes
  const unsubscribe = ieltsSessionEngine.subscribe((newState) => {
    render(newState);
  });
  // Cleanup: stop any in-progress TTS and pending async operations when user leaves the IELTS view
  return () => {
    unsubscribe();
    stopAllTts();
    const currentStatus = ieltsSessionEngine.getState().status;
    if (currentStatus !== 'idle' && currentStatus !== 'completed') {
      ieltsSessionEngine.cancelSession();
    }
  };
}
