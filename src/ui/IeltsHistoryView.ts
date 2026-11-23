import {
  getIeltsTestHistory,
  deleteIeltsTestResult,
  clearIeltsTestHistory,
  type IeltsTestRecord
} from '../storage/ieltsHistoryStore';
import { retryIeltsEvaluation } from '../services/ieltsLlmEvaluator';
import { getSlotAccountReadiness } from '../services/apiFallback';
import { clearIeltsTelemetry, clearLastIeltsEvaluation, getLastIeltsEvaluation } from '../services/ieltsTelemetry';
import { confirmInApp } from './confirmDialog';

export interface IeltsHistoryViewCallbacks {
  onSelectResult: (record: IeltsTestRecord) => void;
  onBackToTest: () => void;
  onRepeatTest?: (record: IeltsTestRecord) => void;
  onRetryEvaluation?: (record: IeltsTestRecord) => Promise<void> | void;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function renderIeltsHistoryView(
  container: HTMLElement,
  callbacks: IeltsHistoryViewCallbacks
): Promise<() => void> {
  const refresh = async (): Promise<void> => {
    const history = await getIeltsTestHistory();

    if (history.length === 0) {
      container.innerHTML = `
        <section class="card ielts-history-card">
          <div class="card-header">
            <div>
              <h1 class="card-title">IELTS Test History</h1>
              <p class="card-subtitle">Your completed speaking sessions, ready whenever you want to review them</p>
            </div>
            <button type="button" class="btn btn-secondary ielts-history-back" id="history-back-btn">
              ← Back to IELTS Test
            </button>
          </div>

          <div class="ielts-history-empty-state">
            <div class="ielts-history-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 4h14v17H5zM8 8h8M8 12h8M8 16h5"/></svg></div>
            <h3 class="ielts-history-empty-title">No practice history yet</h3>
            <p class="ielts-history-empty-copy">
              Your completed speaking sessions will appear here, with scores, feedback and answers to revisit.
            </p>
            <button type="button" class="btn btn-primary" id="history-start-first-btn">
              Start a mock test
            </button>
          </div>
        </section>
      `;

      container.querySelector<HTMLButtonElement>('#history-back-btn')?.addEventListener('click', () => {
        callbacks.onBackToTest();
      });
      container.querySelector<HTMLButtonElement>('#history-start-first-btn')?.addEventListener('click', () => {
        callbacks.onBackToTest();
      });
      return;
    }

    const itemsHtml = history
      .map((item) => {
        const dateStr = new Date(item.timestamp).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });

        const modeBadge =
          item.mode === 'full'
            ? 'Full test'
            : item.mode === 'part1'
              ? 'Part 1'
              : item.mode === 'part2'
                ? 'Part 2'
                : 'Part 3';

        const evalRes = item.evaluation;
        const hasLegacyPronunciationScore = typeof evalRes?.pronunciationBand === 'number';
        const hasLegacyOfflineBand = Boolean(typeof item.overallBand === 'number' && (!evalRes?.activeTier || evalRes.activeTier.tier >= 3));
        const hasUnverifiedLegacyScore = hasLegacyPronunciationScore || hasLegacyOfflineBand;
        const hasScore = Boolean(evalRes && typeof evalRes.activeTier?.tier === 'number' && evalRes.activeTier.tier < 3 && !hasUnverifiedLegacyScore && typeof item.overallBand === 'number');
        const tierBadge = hasScore
          ? 'AI practice estimate · 3 criteria'
          : hasUnverifiedLegacyScore
            ? 'Legacy score hidden'
            : (item.evaluationError ? 'Evaluation pending' : 'No band score');
        const noScoreMessage = hasLegacyPronunciationScore
          ? 'This older score used speech-recognition confidence as a pronunciation estimate. It is hidden because that is not a valid IELTS pronunciation measure. Retry evaluation for a new three-criterion practice estimate.'
          : hasLegacyOfflineBand
            ? 'This older score was produced by rule-based heuristics, which cannot validly assign IELTS bands. It is hidden; retry with an Online AI provider for a practice estimate.'
            : item.evaluationError
              ? `Evaluation could not finish: ${item.evaluationError}`
              : /no band score without ai evaluation/i.test(item.evaluation?.noScoreNotice || '')
                ? 'An AI evaluator was not available, so this report shows speech statistics only.'
                : item.evaluation?.noScoreNotice || 'No band score was created for this attempt.';
        const tierClass = hasScore && evalRes?.activeTier?.tier === 1 ? 'online' : 'offline';

        return `
          <div class="card ielts-history-record" data-record-id="${escapeHtml(item.id)}">
            <div class="ielts-history-record-header">
              <div>
                <span class="ielts-badge-part ielts-history-mode">${modeBadge}</span>${item.attemptNumber ? `<span class="card-subtitle ielts-history-attempt">Attempt ${item.attemptNumber}</span>` : ''}
                <div class="ielts-history-date">${dateStr}</div>
              </div>
              <div class="ielts-history-score-group">
                <span class="tier-badge ${tierClass} ielts-history-tier">
                  <span class="tier-dot"></span>
                  ${tierBadge}
                </span>
                <div class="ielts-band-large ielts-history-band">
                  ${hasScore ? (item.overallBand as number).toFixed(1) : '—'}
                </div>
              </div>
            </div>

            ${hasScore && evalRes ? `
            <details class="ielts-history-more"><summary>Scoring details</summary><div class="ielts-history-criteria">
              <div>
                <div class="ielts-history-criterion-label">Fluency</div>
                <strong class="ielts-history-criterion-value">${evalRes.fluencyCoherenceBand != null ? evalRes.fluencyCoherenceBand.toFixed(1) : '—'}</strong>
              </div>
              <div>
                <div class="ielts-history-criterion-label">Lexical</div>
                <strong class="ielts-history-criterion-value">${evalRes.lexicalResourceBand != null ? evalRes.lexicalResourceBand.toFixed(1) : '—'}</strong>
              </div>
              <div>
                <div class="ielts-history-criterion-label">Grammar</div>
                <strong class="ielts-history-criterion-value">${evalRes.grammaticalRangeBand != null ? evalRes.grammaticalRangeBand.toFixed(1) : '—'}</strong>
              </div>
              <div>
                <div class="ielts-history-criterion-label">Pronunciation</div>
                <strong class="ielts-history-criterion-value">Not assessed</strong>
              </div>
            </div></details>
            ` : `
            <div class="status-box info ielts-history-no-score" role="status">
              <strong>${escapeHtml(noScoreMessage)}</strong>
            </div>
            <div class="ielts-history-objective-stats">
              <span><strong>WPM:</strong> ${item.evaluation?.sessionMetrics?.overallWpm ?? 0}</span>
              <span>·</span>
              <span><strong>Pauses:</strong> ${item.evaluation?.sessionMetrics?.totalPauses ?? 0}</span>
              <span>·</span>
              <span><strong>Fillers:</strong> ${item.evaluation?.sessionMetrics?.totalFillers ?? 0}</span>
              <span>·</span>
              <span><strong>Words:</strong> ${item.evaluation?.sessionMetrics?.totalWords ?? 0}</span>
              <span>·</span>
              <span><strong>Answers:</strong> ${item.answers.length}</span>
            </div>
            `}

            <div class="btn-row ielts-history-actions">
              ${item.plan ? `
              <button type="button" class="btn btn-secondary history-repeat-btn" data-id="${escapeHtml(item.id)}">
                Repeat same test
              </button>
              ` : ''}
              ${item.answers.some(answer => String(answer.transcript || '').trim().length > 0) ? `
              <div class="history-reevaluation-controls">
                <p class="card-subtitle history-reevaluation-help">Normally, no repeat is needed: the first evaluation runs automatically. Automatic uses API 1 and falls back to API 2 when needed. Choose one API only to compare models. If an API fails, answers remain saved; retry after restoring the connection.</p>
                <select class="form-input history-api-choice" data-id="${escapeHtml(item.id)}" aria-label="Re-evaluation method">
                  <option value="auto">Automatic (API 1 or API 2)</option>
                  <option value="primary">API 1 only — compare model</option>
                  <option value="secondary">API 2 only — compare model</option>
                </select>
                <button type="button" class="btn btn-secondary history-retry-btn" data-id="${escapeHtml(item.id)}">Re-evaluate</button>
                <div class="status-box info history-reevaluation-status" role="status" aria-live="polite" hidden></div>
              </div>
              ` : ''}
              <button type="button" class="btn ${hasScore ? 'btn-primary' : 'btn-secondary'} history-view-btn" data-id="${escapeHtml(item.id)}">
                ${hasScore ? 'View full report' : 'Inspect answers'}
              </button>
              <button type="button" class="btn btn-secondary history-delete-btn" data-id="${escapeHtml(item.id)}" aria-label="Delete this test record" title="Delete this test record">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-.8 13H6.8L6 7m3 3v6m6-6v6"/></svg>
                <span>Delete</span>
              </button>
            </div>
          </div>
        `;
      })
      .join('');

    const trendRecords = history.filter(item => {
      const evaluation = item.evaluation;
      const legacyPronunciation = typeof evaluation?.pronunciationBand === 'number';
      const legacyOfflineBand = typeof item.overallBand === 'number' && (!evaluation?.activeTier || evaluation.activeTier.tier >= 3);
      return typeof item.overallBand === 'number' && Number.isFinite(item.overallBand)
        && evaluation?.activeTier?.tier != null && evaluation.activeTier.tier < 3
        && !legacyPronunciation && !legacyOfflineBand;
    }).slice().reverse();
    const trendPoints = trendRecords.map((item, index) => {
      const x = trendRecords.length === 1 ? 160 : 12 + index * (296 / (trendRecords.length - 1));
      const band = Math.max(0, Math.min(9, item.overallBand as number));
      const y = 60 - (band / 9) * 48;
      return { x, y, band };
    });
    const trendChartHtml = trendPoints.length >= 2 ? `
      <section class="ielts-history-trend" aria-label="Practice band trend">
        <div class="ielts-history-trend-heading">
          <strong>Practice trend</strong>
          <span>Last ${trendPoints.length} scored sessions</span>
        </div>
        <svg viewBox="0 0 320 76" role="img" aria-label="Practice band trend from ${trendPoints[0].band.toFixed(1)} to ${trendPoints[trendPoints.length - 1].band.toFixed(1)}">
          <path class="ielts-trend-guide" d="M12 12H308M12 36H308M12 60H308"></path>
          <polyline class="ielts-trend-line" points="${trendPoints.map(point => `${point.x},${point.y}`).join(' ')}"></polyline>
          ${trendPoints.map(point => `<circle class="ielts-trend-point" cx="${point.x}" cy="${point.y}" r="3.5"></circle>`).join('')}
        </svg>
        <div class="ielts-history-trend-labels"><span>Earlier</span><strong>${trendPoints[trendPoints.length - 1].band.toFixed(1)} latest</strong></div>
      </section>` : '';

    container.innerHTML = `
      <section class="card ielts-history-card">
        <div class="card-header">
          <div>
            <h1 class="card-title">IELTS Test History</h1>
            <p class="card-subtitle">${history.length} completed ${history.length === 1 ? 'session' : 'sessions'} recorded</p>
          </div>
          <div class="ielts-history-header-actions">
            <button type="button" class="btn btn-danger ielts-history-clear-all" id="history-clear-all-btn">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-.8 13H6.8L6 7m3 3v6m6-6v6"/></svg>
              Delete all history
            </button>
            <button type="button" class="btn btn-secondary ielts-history-back" id="history-back-btn">
              ← Back to IELTS Test
            </button>
          </div>
        </div>

        ${trendChartHtml}
        <div class="ielts-history-record-list">
          ${itemsHtml}
        </div>
      </section>
    `;

    // Event handlers
    container.querySelector<HTMLButtonElement>('#history-clear-all-btn')?.addEventListener('click', async () => {
      const confirmed = await confirmInApp({
        title: 'Delete all test history?',
        message: 'All saved IELTS sessions and their results will be permanently deleted.',
        confirmLabel: 'Delete all history',
        cancelLabel: 'Keep history',
        tone: 'danger'
      });
      if (confirmed) {
        await clearIeltsTestHistory();
        await clearIeltsTelemetry();
        await refresh();
      }
    });

    container.querySelector<HTMLButtonElement>('#history-back-btn')?.addEventListener('click', () => {
      callbacks.onBackToTest();
    });

    container.querySelectorAll<HTMLButtonElement>('.history-repeat-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const record = history.find(item => item.id === btn.dataset.id);
        if (record?.plan) callbacks.onRepeatTest?.(record);
      });
    });

    container.querySelectorAll<HTMLButtonElement>('.history-view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const rec = history.find((h) => h.id === id);
        if (rec) callbacks.onSelectResult(rec);
      });
    });

    container.querySelectorAll<HTMLElement>('.ielts-history-record').forEach((card) => {
      const choice = card.querySelector<HTMLSelectElement>('.history-api-choice');
      if (!choice) return;
      void (async () => {
        for (const account of ['primary', 'secondary'] as const) {
          const option = choice.querySelector<HTMLOptionElement>(`option[value="${account}"]`);
          if (!option) continue;
          const readiness = await getSlotAccountReadiness('llm_evaluator', account);
          option.disabled = !readiness.usable;
          option.title = readiness.usable ? '' : readiness.reason;
          if (!readiness.usable && !option.textContent?.includes('(not ready)')) option.textContent += ' (not ready — test in Settings)';
        }
      })();
    });

    container.querySelectorAll<HTMLButtonElement>('.history-retry-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const rec = history.find((h) => h.id === id);
        if (!rec) return;
        const recordCard = btn.closest<HTMLElement>('.ielts-history-record');
        const choiceSelect = recordCard?.querySelector<HTMLSelectElement>('.history-api-choice');
        const providerChoice = (choiceSelect?.value || 'auto') as 'auto' | 'primary' | 'secondary';
        const inlineStatus = recordCard?.querySelector<HTMLElement>('.history-reevaluation-status');
        btn.disabled = true;
        btn.textContent = 'Re-evaluating…';
        if (inlineStatus) { inlineStatus.hidden = false; inlineStatus.className = 'status-box info history-reevaluation-status'; inlineStatus.textContent = 'Re-evaluation in progress…'; }
        try {
          if (providerChoice === 'auto' && callbacks.onRetryEvaluation) {
            await callbacks.onRetryEvaluation(rec);
            await refresh();
            const refreshedCard = Array.from(container.querySelectorAll<HTMLElement>('.ielts-history-record'))
              .find(card => card.dataset.recordId === id);
            const refreshedStatus = refreshedCard?.querySelector<HTMLElement>('.history-reevaluation-status');
            if (refreshedStatus) {
              refreshedStatus.hidden = false;
              refreshedStatus.className = 'status-box pass history-reevaluation-status';
              refreshedStatus.textContent = 'Re-evaluation completed.';
            }
          } else {
            const updated = await retryIeltsEvaluation(rec, undefined, { providerChoice });
            await refresh();
            const refreshedCard = Array.from(container.querySelectorAll<HTMLElement>('.ielts-history-record'))
              .find(card => card.dataset.recordId === id);
            const refreshedStatus = refreshedCard?.querySelector<HTMLElement>('.history-reevaluation-status');
            if (refreshedStatus) {
              refreshedStatus.hidden = false;
              refreshedStatus.className = 'status-box pass history-reevaluation-status';
              refreshedStatus.textContent = `Re-evaluated successfully with ${providerChoice === 'secondary' ? 'API 2' : providerChoice === 'primary' ? 'API 1' : (updated.evaluation?.activeTier?.detailLabel || 'the selected provider')}.`;
            }
          }
        } catch (error) {
          btn.disabled = false;
          btn.textContent = 'Re-evaluate';
          if (inlineStatus) { inlineStatus.hidden = false; inlineStatus.className = 'status-box fail history-reevaluation-status'; inlineStatus.textContent = error instanceof Error ? error.message : String(error); }
        }
      });
    });

    container.querySelectorAll<HTMLButtonElement>('.history-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (!id) return;
        const confirmed = await confirmInApp({
          title: 'Delete this test record?',
          message: 'This saved session and its report will be removed from your history.',
          confirmLabel: 'Delete record',
          cancelLabel: 'Keep record',
          tone: 'danger'
        });
        if (confirmed) {
          const lastEvaluation = await getLastIeltsEvaluation();
          await deleteIeltsTestResult(id);
          if (lastEvaluation?.id === id) await clearLastIeltsEvaluation();
          await refresh();
        }
      });
    });
  };

  await refresh();
  return () => {};
}
