import type { IeltsTestRecord } from '../storage/ieltsHistoryStore';
import { recordLastIeltsEvaluation } from '../services/ieltsTelemetry';
import { retryIeltsEvaluation } from '../services/ieltsLlmEvaluator';
import { getSlotAccountReadiness } from '../services/apiFallback';

export interface IeltsResultViewCallbacks {
  onRetake: () => void;
  onBackToHistory: () => void;
  onReturnToMenu?: () => void;
  onRetryEvaluation?: (record: IeltsTestRecord) => Promise<void> | void;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderIeltsResultView(
  container: HTMLElement,
  record: IeltsTestRecord,
  callbacks: IeltsResultViewCallbacks
): void {
  // Record telemetry for Diagnostics view
  recordLastIeltsEvaluation(record).catch(() => {});

  const modeTitle =
    record.mode === 'full'
      ? 'Full Mock Test (Parts 1, 2, 3)'
      : record.mode === 'part1'
        ? 'Part 1: Interview'
        : record.mode === 'part2'
          ? 'Part 2: Long Turn'
          : 'Part 3: Discussion';

  const dateStr = new Date(record.timestamp).toLocaleString();

  const comparison = record.comparison;
  const comparisonHasLegacyPronunciation = Boolean(comparison && (
    typeof comparison.criteria.pronunciation.previous === 'number' ||
    typeof comparison.criteria.pronunciation.current === 'number'
  ));
  const comparisonHtml = comparison ? `
    <section class="card ielts-result-section ielts-result-section-spaced">
      <h3 class="card-title">Progress compared with your previous attempt</h3>
      <p class="card-subtitle ielts-comparison-summary">${escapeHtml(comparison.summary)}</p>
      ${comparisonHasLegacyPronunciation
        ? '<p class="status-box info">Score comparison is hidden because an older attempt included an unvalidated pronunciation estimate. Re-evaluate both attempts for comparable three-criterion practice estimates.</p>'
        : `<p class="ielts-comparison-overall"><strong>3-criterion practice estimate:</strong> ${comparison.overallBandPrevious ?? '—'} → ${comparison.overallBandCurrent ?? '—'} ${comparison.overallBandChange === null ? '' : `<span class="ielts-comparison-overall-change ${comparison.overallBandChange > 0 ? 'positive' : comparison.overallBandChange < 0 ? 'negative' : 'neutral'}">(${comparison.overallBandChange > 0 ? '+' : ''}${comparison.overallBandChange.toFixed(1)})</span>`}</p>`}

      <div class="ielts-score-grid ielts-comparison-score-grid">
        ${([
          ['Fluency & Coherence', comparison.criteria.fluencyCoherence],
          ['Lexical Resource', comparison.criteria.lexicalResource],
          ['Grammar', comparison.criteria.grammar],
          ['Pronunciation', { previous: null, current: null, change: null, analysis: 'Not assessed. Speech-recognition confidence is not an IELTS pronunciation measure.' }]
        ] as Array<[string, {previous:number|null;current:number|null;change:number|null;analysis:string}]>)
          .map(([label, item]) => `
            <div class="ielts-subscore-card">
              <div class="ielts-subscore-label">${label}</div>
              <div class="ielts-subscore-val">${item.previous ?? '—'} → ${item.current ?? '—'} ${item.change === null ? '' : `<small class="ielts-comparison-change ${item.change > 0 ? 'positive' : item.change < 0 ? 'negative' : 'neutral'}">${item.change > 0 ? '+' : ''}${item.change.toFixed(1)}</small>`}</div>
              <div class="ielts-subscore-desc">${escapeHtml(item.analysis)}</div>
            </div>
          `).join('')}
      </div>
      ${comparison.answerComparisons.length ? `
        <details class="ielts-comparison-details" open>
          <summary class="ielts-comparison-summary-toggle">Changes in actual answers (${comparison.answerComparisons.length})</summary>
          <div class="ielts-comparison-answer-list">
            ${comparison.answerComparisons.map(item => `
              <div class="ielts-comparison-answer-card">
                <strong>${escapeHtml(item.question)}</strong>
                <div class="card-subtitle ielts-comparison-answer-previous">Previous: ${escapeHtml(item.previousAnswer)}</div>
                <div class="card-subtitle ielts-comparison-answer-current">Current: ${escapeHtml(item.currentAnswer)}</div>
                <p class="ielts-comparison-analysis">${escapeHtml(item.analysis)}</p>
              </div>
            `).join('')}
          </div>
        </details>
      ` : ''}
      ${comparison.strengths.length ? `<p class="ielts-comparison-strengths"><strong>Improvements:</strong> ${comparison.strengths.map(escapeHtml).join(' · ')}</p>` : ''}
      ${comparison.priorities.length ? `<p class="ielts-comparison-priorities"><strong>Next priorities:</strong> ${comparison.priorities.map(escapeHtml).join(' · ')}</p>` : ''}
    </section>
  ` : record.comparisonError ? `
    <section class="card ielts-result-section ielts-result-section-spaced">
      <strong>Attempt comparison unavailable</strong>
      <p class="card-subtitle">${escapeHtml(record.comparisonError)} Your new test result is saved normally.</p>
    </section>
  ` : '';


  // Candidate transcripts HTML
  let transcriptsHtml = '';
  if (record.answers && record.answers.length > 0) {
    transcriptsHtml = `
      <section class="card ielts-result-section ielts-result-section-spaced">
        <details open>
          <summary class="ielts-transcript-summary">
            Your spoken answers (${record.answers.length})
          </summary>
          <div class="ielts-transcript-list">
            ${record.answers
              .map(
                (ans, idx) => {
                  const isSkipped = ans.wasSkipped || ans.transcript === '[Question skipped by candidate]';
                  return `
              <div class="ielts-feedback-card">
                <div class="ielts-transcript-header">
                  <strong class="ielts-transcript-question">Q${idx + 1}: ${escapeHtml(ans.questionText)}</strong>
                  <div class="ielts-transcript-meta">
                    ${isSkipped ? '<span class="ielts-transcript-skipped">Skipped</span>' : ''}
                    <span class="ielts-transcript-duration">${ans.durationSec}s${ans.wpm ? ` · ${ans.wpm} WPM` : ''}</span>
                  </div>
                </div>
                <p class="ielts-transcript-answer ${isSkipped ? 'is-skipped' : ''}">
                  ${isSkipped ? 'Question was skipped by candidate (No speech recorded)' : `"${escapeHtml(ans.transcript || '(No speech detected)')}"`}
                </p>
              </div>
            `;
                }
              )
              .join('')}
          </div>
        </details>
      </section>
    `;
  }

  const exportText = [
    'SpeakCoach — IELTS Speaking Test',
    `Date: ${dateStr}`,
    `Test: ${modeTitle}`,
    '',
    ...record.answers.flatMap((answer, index) => [
      `Q${index + 1} (${answer.part.toUpperCase()}): ${answer.questionText}`,
      `Answer: ${answer.wasSkipped || answer.transcript === '[Question skipped by candidate]' ? '[Skipped]' : (answer.transcript || '[No transcript]')}`,
      ''
    ])
  ].join('\n');

  const exportSectionHtml = record.answers.length > 0 ? `
    <section class="card ielts-result-section ielts-result-section-spaced" id="ielts-export-card">
      <h3 class="card-title ielts-result-section-title">Questions &amp; Answers — Copy All</h3>
      <p class="card-subtitle ielts-export-description">For external analysis outside the app, if needed.</p>
      <textarea id="ielts-export-text" class="form-input ielts-export-textarea" readonly rows="10">${escapeHtml(exportText)}</textarea>
      <div class="btn-row">
        <button type="button" class="btn btn-secondary" id="ielts-copy-export-btn">Copy all questions &amp; answers</button>
        <span id="ielts-copy-export-status" class="card-subtitle" role="status" aria-live="polite"></span>
      </div>
    </section>
  ` : '';

  const attachExportCopyHandler = (): void => {
    const copyBtn = container.querySelector<HTMLButtonElement>('#ielts-copy-export-btn');
    const exportArea = container.querySelector<HTMLTextAreaElement>('#ielts-export-text');
    const copyStatus = container.querySelector<HTMLElement>('#ielts-copy-export-status');
    copyBtn?.addEventListener('click', async () => {
      if (!exportArea) return;
      try {
        await navigator.clipboard.writeText(exportArea.value);
        if (copyStatus) copyStatus.textContent = 'Copied.';
      } catch {
        exportArea.focus();
        exportArea.select();
        const copied = document.execCommand('copy');
        if (copyStatus) copyStatus.textContent = copied
          ? 'Copied.'
          : 'Text selected — use Copy from your device menu.';
      }
    });
  };

  const evaluationHistoryHtml = record.evaluationHistory?.length ? `
    <section class="card ielts-result-section ielts-result-section-spaced">
      <h3 class="card-title">Previous evaluation results</h3>
      <p class="card-subtitle">Each evaluation is kept separately, so comparing providers will not erase earlier results.</p>
      <div class="ielts-evaluation-history-list">
        ${record.evaluationHistory.map((entry, index) => `
          <div class="ielts-evaluation-history-item">
            <span>${entry.mode === 'offline' ? 'Legacy evaluation' : escapeHtml(entry.result.activeTier?.detailLabel || entry.providerName || 'Online API')} · ${entry.result.overallBand === null ? 'No band score' : `Band ${entry.result.overallBand}`} · ${new Date(entry.evaluatedAt).toLocaleString()}</span>
            <button type="button" class="btn btn-secondary result-view-evaluation-btn" data-index="${index}">View</button>
          </div>
        `).join('')}
      </div>
    </section>
  ` : '';

  const evaluationControlsHtml = `
    <div class="ielts-reevaluation-controls">
      <div class="status-box info ielts-reevaluation-help">
        <strong>When should you re-evaluate?</strong>
        <p>The first API evaluation runs automatically after the test. You normally do not need to run it again.</p>
        <p>If the API connection fails, your answers remain saved in History. Re-evaluate after restoring the connection. Choose API 1 or API 2 separately only when comparing models; Automatic tries API 1 and falls back to API 2.</p>
      </div>
      <label class="form-label" for="result-api-choice">Re-evaluation method</label>
      <select class="form-input" id="result-api-choice">
        <option value="auto">Automatic (API 1 or API 2)</option>
        <option value="primary">API 1 only — compare model</option>
        <option value="secondary">API 2 only — compare model</option>
      </select>
      <button type="button" class="btn btn-primary" id="result-retry-eval-btn">Re-evaluate</button>
      <div class="status-box info ielts-reevaluation-status" id="result-reevaluation-status" role="status" aria-live="polite"></div>
    </div>
  `;

  const attachReevaluationHandlers = (): void => {
    const apiChoice = container.querySelector<HTMLSelectElement>('#result-api-choice');
    const apiButton = container.querySelector<HTMLButtonElement>('#result-retry-eval-btn');
    const status = container.querySelector<HTMLElement>('#result-reevaluation-status');
    const updateChoices = async (): Promise<void> => {
      if (!apiChoice) return;
      for (const account of ['primary', 'secondary'] as const) {
        const option = apiChoice.querySelector<HTMLOptionElement>(`option[value="${account}"]`);
        if (!option) continue;
        const readiness = await getSlotAccountReadiness('llm_evaluator', account);
        option.disabled = !readiness.usable;
        option.title = readiness.usable ? '' : readiness.reason;
        if (!readiness.usable && !option.textContent?.includes('(not ready)')) option.textContent += ' (not ready — test in Settings)';
      }
    };
    void updateChoices();

    const run = async (providerChoice: 'auto' | 'primary' | 'secondary', button: HTMLButtonElement | null) => {
      if (!button) return;
      button.disabled = true;
      const originalText = button.textContent || 'Re-evaluate';
      button.textContent = 'Re-evaluating…';
      if (status) { status.hidden = false; status.className = 'status-box info ielts-reevaluation-status'; status.textContent = 'Re-evaluation in progress…'; }
      try {
        if (providerChoice === 'auto' && callbacks.onRetryEvaluation) {
          await callbacks.onRetryEvaluation(record);
          if (status) { status.className = 'status-box pass ielts-reevaluation-status'; status.textContent = 'Re-evaluation completed.'; }
          return;
        }
        const updated = await retryIeltsEvaluation(record, undefined, { providerChoice });
        renderIeltsResultView(container, updated, callbacks);
        const nextStatus = container.querySelector<HTMLElement>('#result-reevaluation-status');
        if (nextStatus) { nextStatus.hidden = false; nextStatus.className = 'status-box pass ielts-reevaluation-status'; nextStatus.textContent = `Re-evaluated successfully with ${providerChoice === 'secondary' ? 'API 2' : providerChoice === 'primary' ? 'API 1' : (updated.evaluation?.activeTier?.detailLabel || 'the selected provider')}.`; }
      } catch (error) {
        button.disabled = false;
        button.textContent = originalText;
        if (status) { status.hidden = false; status.className = 'status-box fail ielts-reevaluation-status'; status.textContent = error instanceof Error ? error.message : String(error); }
      }
    };

    apiButton?.addEventListener('click', async () => {
      const choice = (apiChoice?.value || 'auto') as 'auto' | 'primary' | 'secondary';
      await run(choice, apiButton);
    });

    container.querySelectorAll<HTMLButtonElement>('.result-view-evaluation-btn').forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.index);
        const entry = record.evaluationHistory?.[index];
        if (!entry) return;
        renderIeltsResultView(container, {
          ...record,
          evaluation: entry.result,
          overallBand: entry.result.overallBand,
          evaluationError: null
        }, callbacks);
      });
    });
  };

  const evalRes = record.evaluation;
  const hasLegacyPronunciationScore = typeof evalRes?.pronunciationBand === 'number';
  const hasLegacyOfflineBand = Boolean(typeof record.overallBand === 'number' && (!evalRes?.activeTier || evalRes.activeTier.tier >= 3));
  const hasUnverifiedLegacyScore = hasLegacyPronunciationScore || hasLegacyOfflineBand;

  const criterionItems = evalRes ? [
    { key: 'fluency', label: 'Fluency & Coherence', score: evalRes.fluencyCoherenceBand, comment: evalRes.perCriterionComments?.fluency || '' },
    { key: 'lexical', label: 'Lexical Resource', score: evalRes.lexicalResourceBand, comment: evalRes.perCriterionComments?.lexical || '' },
    { key: 'grammar', label: 'Grammar & Accuracy', score: evalRes.grammaticalRangeBand, comment: evalRes.perCriterionComments?.grammar || '' },
    { key: 'pronunciation', label: 'Pronunciation', score: null, comment: evalRes.pronunciationNotice || 'Not assessed — speech-recognition confidence is not an IELTS pronunciation measure.' }
  ] : [];

  const scoredCriteria = criterionItems.filter(
    (item) => typeof item.score === 'number' && Number.isFinite(item.score)
  ) as Array<{ key: string; label: string; score: number; comment: string }>;
  const lowestCriterion = scoredCriteria.length
    ? scoredCriteria.reduce((lowest, current) => current.score < lowest.score ? current : lowest)
    : null;

  const criterionBarsHtml = criterionItems.map((item) => {
    const score = typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : null;
    const progress = score === null ? 0 : Math.max(0, Math.min(9, score)) / 9 * 100;
    const scoreText = score === null ? (item.key === 'pronunciation' ? 'Not assessed' : '—') : score.toFixed(1);
    const pronunciationId = item.key === 'pronunciation' ? ' id="result-pronunciation-card"' : '';
    const valueId = item.key === 'pronunciation' ? ' id="result-pronunciation-band"' : '';
    const commentId = item.key === 'pronunciation' ? ' id="result-pronunciation-desc"' : '';
    return `
      <article class="ielts-criterion-row" data-criterion="${item.key}"${pronunciationId}>
        <div class="ielts-criterion-heading">
          <span class="ielts-criterion-name">${item.label}${item.key === 'pronunciation' ? '<small class="ielts-criterion-note">(Not assessed)</small>' : ''}</span>
          <strong class="ielts-criterion-score"${valueId}>${scoreText}</strong>
        </div>
        <div class="ielts-criterion-track" aria-hidden="true"><span style="width:${progress}%"></span></div>
        <p class="ielts-criterion-comment"${commentId}>${escapeHtml(item.comment)}</p>
      </article>
    `;
  }).join('');

  const nextFocusHtml = lowestCriterion ? `
    <section class="ielts-next-focus" aria-label="Next practice focus">
      <span class="ielts-next-focus-label">A useful next focus</span>
      <strong>${lowestCriterion.label}</strong>
      <p>This was the lowest of the three assessed criteria in this attempt (${lowestCriterion.score.toFixed(1)}).</p>
    </section>
  ` : '';

  const ringCircumference = 2 * Math.PI * 48;
  const overallBandValue = typeof record.overallBand === 'number' ? record.overallBand : null;
  const bandRingHtml = (value: number | null): string => `
    <div class="ielts-band-ring" role="img" aria-label="${value === null ? 'No valid three-criterion practice estimate was produced' : `Three-criterion practice estimate ${value.toFixed(1)} out of 9`}">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle class="ielts-band-ring-track" cx="60" cy="60" r="48"></circle>
        <circle class="ielts-band-ring-progress" cx="60" cy="60" r="48" stroke-dasharray="${ringCircumference.toFixed(2)}" stroke-dashoffset="${value === null ? ringCircumference.toFixed(2) : (ringCircumference * (1 - Math.max(0, Math.min(9, value)) / 9)).toFixed(2)}" transform="rotate(-90 60 60)"></circle>
      </svg>
      <span class="ielts-band-number" id="result-overall-band">${value === null ? '—' : value.toFixed(1)}</span>
    </div>
  `;


  // Objective speech statistics
  const stats = evalRes?.sessionMetrics;
  const wordCount =
    stats?.totalWords ??
    record.answers.reduce(
      (sum, a) => sum + (a.transcript ? a.transcript.trim().split(/\s+/).filter(Boolean).length : 0),
      0
    );
  const wpm =
    stats?.overallWpm ??
    (record.answers.length > 0
      ? Math.round(record.answers.reduce((sum, a) => sum + (a.wpm || 0), 0) / record.answers.length)
      : 0);
  const pauses = stats?.totalPauses ?? 0;
  const fillers = stats?.totalFillers ?? 0;
  const answerCount = record.answers.length;

  const objectiveStatsHtml = `
    <details class="ielts-result-disclosure"><summary>Speech statistics</summary>
    <section class="card ielts-result-section ielts-result-section-spaced" id="result-objective-stats">
      <div class="card-header">
        <h3 class="card-title ielts-result-section-title">Speech statistics</h3>
        <span class="tier-badge offline">Speech statistics only</span>
      </div>
      <div class="ielts-objective-stats-grid">
        <div class="ielts-objective-stat-card">
          <div class="ielts-objective-stat-label">WPM</div>
          <div class="ielts-objective-stat-value" id="stat-wpm">${wpm}</div>
        </div>
        <div class="ielts-objective-stat-card">
          <div class="ielts-objective-stat-label">Pauses</div>
          <div class="ielts-objective-stat-value" id="stat-pauses">${pauses}</div>
        </div>
        <div class="ielts-objective-stat-card">
          <div class="ielts-objective-stat-label">Fillers</div>
          <div class="ielts-objective-stat-value" id="stat-fillers">${fillers}</div>
        </div>
        <div class="ielts-objective-stat-card">
          <div class="ielts-objective-stat-label">Word Count</div>
          <div class="ielts-objective-stat-value" id="stat-words">${wordCount}</div>
        </div>
        <div class="ielts-objective-stat-card">
          <div class="ielts-objective-stat-label">Answer Count</div>
          <div class="ielts-objective-stat-value" id="stat-answers">${answerCount}</div>
        </div>
      </div>
    </section>
    </details>
  `;

  // Grammar corrections HTML
  let grammarHtml = '';
  if (evalRes?.corrections && evalRes.corrections.length > 0) {
    grammarHtml = `
      <details class="ielts-result-disclosure"><summary>Grammar corrections (${evalRes.corrections.length})</summary>
      <section class="card ielts-result-section ielts-result-section-spaced">
        <h3 class="card-title ielts-result-section-title">Grammar corrections</h3>
        <div class="ielts-feedback-list">
          ${evalRes.corrections
            .map(
              (c) => `
            <div class="ielts-feedback-card">
              <div class="ielts-correction-original">
                ${escapeHtml(c.original)}
              </div>
              <div class="ielts-correction-corrected">
                ➜ ${escapeHtml(c.corrected)}
              </div>
              <div class="ielts-feedback-explanation">
                ${escapeHtml(c.explanation)}
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      </section>
      </details>
    `;
  }

  // Vocabulary upgrades HTML
  let vocabHtml = '';
  if (evalRes?.vocabularyUpgrades && evalRes.vocabularyUpgrades.length > 0) {
    vocabHtml = `
      <details class="ielts-result-disclosure"><summary>Vocabulary upgrades (${evalRes.vocabularyUpgrades.length})</summary>
      <section class="card ielts-result-section ielts-result-section-spaced">
        <h3 class="card-title ielts-result-section-title">Vocabulary upgrades</h3>
        <div class="ielts-feedback-list">
          ${evalRes.vocabularyUpgrades
            .map(
              (v) => `
            <div class="ielts-feedback-card">
              <div class="ielts-vocab-upgrade-row">
                <span class="ielts-vocab-original">${escapeHtml(v.original)}</span>
                <span class="ielts-vocab-arrow" aria-hidden="true">→</span>
                <strong class="ielts-vocab-upgraded">${escapeHtml(v.upgraded)}</strong>
              </div>
              <div class="ielts-vocab-context">
                "${escapeHtml(v.context)}"
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      </section>
      </details>
    `;
  }

  // Model answers HTML
  let modelAnswersHtml = '';
  if (evalRes?.modelAnswers && evalRes.modelAnswers.length > 0) {
    modelAnswersHtml = `
      <details class="ielts-result-disclosure"><summary>Model answers (${evalRes.modelAnswers.length})</summary>
      <section class="card ielts-result-section ielts-result-section-spaced">
        <h3 class="card-title ielts-result-section-title">Band 7–9 model answers</h3>
        <div class="ielts-feedback-list">
          ${evalRes.modelAnswers
            .map(
              (m) => `
            <div class="ielts-feedback-card">
              <div class="ielts-model-question">
                ${escapeHtml(m.question)}
              </div>
              <p class="ielts-model-answer">
                ${escapeHtml(m.band7ModelAnswer)}
              </p>
            </div>
          `
            )
            .join('')}
        </div>
      </section>
      </details>
    `;
  }

  // CASE 1: No evaluation / initial evaluation failed / Offline / Very short answers -> DO NOT produce any band score.
  // Ignore stale retry errors on records that already contain a valid online evaluation.
  const hasValidStoredBand = Boolean(evalRes && typeof record.overallBand === 'number' && Number.isFinite(record.overallBand) && (evalRes.activeTier?.tier ?? 3) < 3);
  if (!evalRes || record.overallBand === null || (record.evaluationError && !hasValidStoredBand) || hasUnverifiedLegacyScore || (evalRes.activeTier?.tier ?? 3) >= 3) {
    const errorReason = hasValidStoredBand ? null : record.evaluationError;
    const noScoreNotice = evalRes?.noScoreNotice || (wordCount < 15 ? 'Candidate gave no or very short answers: no scores produced.' : 'An AI evaluator was not available for this attempt.');
    const badgeLabel = errorReason ? 'Evaluation pending' : hasUnverifiedLegacyScore ? 'Legacy score hidden' : 'No band score';
    const friendlyNoScoreMessage = hasLegacyPronunciationScore
      ? 'This older result used speech-recognition confidence as an IELTS pronunciation score. That is not a valid pronunciation assessment, so the overall score is hidden. Retry evaluation to create a new three-criterion practice estimate.'
      : hasLegacyOfflineBand
        ? 'This older result used rule-based heuristics to create an IELTS band number. Those heuristics cannot validly assign IELTS bands, so the score is hidden. Retry with an Online AI provider for a practice estimate.'
        : errorReason
          ? 'The evaluator could not complete this assessment. You can retry it or start a new test.'
          : /very short|no or very short/i.test(noScoreNotice)
        ? 'Your answers were too brief to produce a reliable band estimate.'
        : /no band score without ai evaluation|ai evaluator was not available/i.test(noScoreNotice)
          ? 'An AI evaluator was not available for this attempt, so this report shows your objective speech statistics instead.'
          : noScoreNotice;
    const showDetailedShortAnswerNotice = Boolean(evalRes?.noScoreNotice && !errorReason && /very short|insufficient speech/i.test(noScoreNotice));

    container.innerHTML = `
      <section class="card ielts-result-section">
        <div class="card-header">
          <div>
            <h2 class="card-title ielts-result-title">IELTS Speaking Test Report</h2>
            <p class="card-subtitle">${modeTitle} · ${dateStr}</p>
          </div>
          <span class="tier-badge offline">
            <span class="tier-dot"></span>${badgeLabel}
          </span>
        </div>

        <div class="ielts-band-hero ielts-band-hero-empty">
          ${bandRingHtml(null)}
          <div class="ielts-band-hero-copy">
            <span class="ielts-band-hero-label">IELTS practice scoring</span>
            <strong class="ielts-no-score-title">${hasUnverifiedLegacyScore ? 'No valid score available' : 'No band score this time'}</strong>
            <p class="ielts-no-score-copy">${escapeHtml(friendlyNoScoreMessage)}</p>
          </div>
        </div>

        ${
          errorReason
            ? `
        <div class="status-box fail ielts-result-error ielts-result-inline-notice" id="result-failure-reason">
          <strong>${escapeHtml(errorReason)}</strong>
        </div>
        `
            : ''
        }

        ${
          showDetailedShortAnswerNotice
            ? `
        <div class="status-box info ielts-result-notice ielts-result-inline-notice" id="result-short-answers-notice">
          <strong>${escapeHtml(evalRes?.noScoreNotice || noScoreNotice)}</strong>
        </div>
        `
            : ''
        }

        ${evaluationControlsHtml}
        <div class="btn-row ielts-result-actions">
          <button type="button" class="btn ${errorReason ? 'btn-secondary' : 'btn-primary'}" id="result-retake-btn">
            Start New Test
          </button>
          <button type="button" class="btn btn-secondary" id="result-menu-btn">
            Return to Menu
          </button>
          <button type="button" class="btn btn-secondary" id="result-history-btn">
            View History
          </button>
        </div>
      </section>

      ${comparisonHtml}
    ${evaluationHistoryHtml}
    ${objectiveStatsHtml}
      ${grammarHtml}
      ${vocabHtml}
      ${modelAnswersHtml}
      ${transcriptsHtml}
      ${exportSectionHtml}
    `;

    attachExportCopyHandler();

    attachReevaluationHandlers();

    container.querySelector<HTMLButtonElement>('#result-retake-btn')?.addEventListener('click', () => {
      callbacks.onRetake();
    });

    container.querySelector<HTMLButtonElement>('#result-menu-btn')?.addEventListener('click', () => {
      if (callbacks.onReturnToMenu) {
        callbacks.onReturnToMenu();
      } else {
        callbacks.onRetake();
      }
    });

    container.querySelector<HTMLButtonElement>('#result-history-btn')?.addEventListener('click', () => {
      callbacks.onBackToHistory();
    });

    return;
  }

  // CASE 2: Evaluation present -> render full band score report
  const isOnlineTier = evalRes.activeTier.tier < 3;
  const tierClass = isOnlineTier ? 'online' : 'offline';
  const tierText = isOnlineTier
    ? 'Online AI practice estimate (three criteria only)'
    : 'Practice feedback only — no valid IELTS band score';

  container.innerHTML = `
    <section class="card ielts-result-section">
      <div class="card-header">
        <div>
          <h2 class="card-title ielts-result-title">IELTS Speaking Test Report</h2>
          <p class="card-subtitle">${modeTitle} · ${dateStr}</p>
        </div>
        <span class="tier-badge ${tierClass}">
          <span class="tier-dot"></span>
          ${isOnlineTier ? 'AI practice estimate' : 'Legacy evaluation'}
        </span>
      </div>

      <div class="ielts-band-hero">
        ${bandRingHtml(overallBandValue)}
        <div class="ielts-band-hero-copy">
          <span class="ielts-band-hero-label">3-criterion practice estimate</span>
          <strong class="ielts-band-hero-tier">${tierText}</strong>
          <p class="ielts-band-hero-confidence">${escapeHtml(evalRes.confidenceLabel || 'Practice feedback only — not an official IELTS score.')}</p>
          ${evalRes.fallbackReason || (evalRes.activeTier?.isFallback && evalRes.activeTier?.reason) ? `
            <div class="ielts-fallback-note" id="ielts-fallback-reason"><strong>Backup evaluator:</strong> ${escapeHtml(evalRes.fallbackReason || evalRes.activeTier.reason || '')}</div>
          ` : ''}
        </div>
      </div>

      <details class="ielts-result-disclosure"><summary>Scoring criteria &amp; next steps</summary>
      <section class="ielts-criteria-section" aria-label="IELTS scoring criteria">
        <h3 class="ielts-criteria-title">Assessed criteria</h3>
        <p class="card-subtitle">Three criteria are estimated. Pronunciation is not assessed by speech-recognition confidence.</p>
        <div class="ielts-criteria-list">${criterionBarsHtml}</div>
      </section>
      ${nextFocusHtml}
      </details>

      ${evaluationControlsHtml}
      <div class="btn-row ielts-result-actions">
        <button type="button" class="btn btn-primary" id="result-retake-btn">
          Start New Test
        </button>
        <button type="button" class="btn btn-secondary" id="result-menu-btn">
          Return to Menu
        </button>
        <button type="button" class="btn btn-secondary" id="result-history-btn">
          View History
        </button>
      </div>
    </section>

    ${evaluationHistoryHtml}
    ${objectiveStatsHtml}

    ${grammarHtml}
    ${vocabHtml}
    ${modelAnswersHtml}
    ${transcriptsHtml}
    ${exportSectionHtml}
  `;

  // Attach event handlers
  attachExportCopyHandler();
  attachReevaluationHandlers();
  container.querySelector<HTMLButtonElement>('#result-retake-btn')?.addEventListener('click', () => {
    callbacks.onRetake();
  });

  container.querySelector<HTMLButtonElement>('#result-menu-btn')?.addEventListener('click', () => {
    if (callbacks.onReturnToMenu) {
      callbacks.onReturnToMenu();
    } else {
      callbacks.onRetake();
    }
  });

  container.querySelector<HTMLButtonElement>('#result-history-btn')?.addEventListener('click', () => {
    callbacks.onBackToHistory();
  });
}
