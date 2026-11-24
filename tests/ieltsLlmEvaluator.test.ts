import type { HttpOptions, HttpResponse } from '@capacitor/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildIeltsEvaluationPrompt,
  compareIeltsAttempts,
  cleanJsonPayload,
  clearLlmEvaluationTelemetry,
  evaluateIeltsWithTierFallback,
  getLastLlmEvaluationTelemetry,
  LlmEvaluationFailureError,
  IeltsApiRequiredError,
  requestLlmIeltsEvaluation,
  retryIeltsEvaluation
} from '../src/services/ieltsLlmEvaluator';
import type { IeltsAnswerInput } from '../src/services/ieltsOfflineEvaluator';
import { clearIeltsSessionLogs, getIeltsSessionLogs } from '../src/services/ieltsTelemetry';
import { generateIeltsSessionPlan } from './fixtures/legacyIeltsQuestionBank';
import { networkMonitor } from '../src/services/networkMonitor';
import { clearAllRuntimeFailures } from '../src/services/tierManager';
import { clearAllProviderAccountHealth, createProviderVerificationFingerprint } from '../src/services/providerHealth';
import { loadApiKey, saveApiKey } from '../src/storage/keyStore';
import { loadAllSlotsConfig, saveSlotConfig, saveSlotConnectionTestResult, saveSecondarySlotConfig } from '../src/storage/localStore';
import {
  clearIeltsDraft,
  clearIeltsTestHistory,
  getIeltsTestHistory,
  loadIeltsDraft,
  saveIeltsTestResult,
  saveIeltsDraft
} from '../src/storage/ieltsHistoryStore';
import { IeltsSessionController } from '../src/services/ieltsSessionEngine';
import { renderIeltsHistoryView } from '../src/ui/IeltsHistoryView';
import { renderIeltsResultView } from '../src/ui/IeltsResultView';


async function verifyEvaluator(providerId: 'openai_compat_eval' | 'gemini_eval'): Promise<void> {
  const config = (await loadAllSlotsConfig()).llm_evaluator;
  const apiKey = await loadApiKey('llm_evaluator', providerId);
  const verificationFingerprint = await createProviderVerificationFingerprint(config, apiKey);
  await saveSlotConnectionTestResult('llm_evaluator', {
    ok: true, slotId: 'llm_evaluator', providerId, tier: 1,
    label: 'Online AI', latencyMs: 1, message: 'PASS — test fixture',
    verificationFingerprint: verificationFingerprint ?? undefined
  });
}

describe('IELTS LLM Evaluator Engine (Stage 3.4 · Tier 1 & Fallback)', () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearAllProviderAccountHealth();
    clearAllRuntimeFailures();
    clearIeltsSessionLogs();
    clearLlmEvaluationTelemetry();
    networkMonitor.setOnline(true);
  });

  const sampleAnswers: IeltsAnswerInput[] = [
    {
      questionId: 'q1',
      part: 1,
      question: 'Where is your hometown?',
      transcript:
        'My hometown is located in the northern region. It is a very vibrant city with many cultural landmarks and green parks.',
      durationMs: 12000,
      confidence: 0.92
    },
    {
      questionId: 'q2',
      part: 2,
      question: 'Describe a memorable journey you took.',
      transcript:
        'I would like to talk about a train trip I took across the country with my university friends two years ago. The scenery was breathtaking.',
      durationMs: 25000,
      confidence: 0.90
    }
  ];



  it('reports actionable readiness reasons for a failed comparison without modifying either scored record', async () => {
    const previous = await saveIeltsTestResult({
      id: 'comparison-previous-score',
      mode: 'part1', timestamp: Date.now() - 1000, overallBand: 6.5,
      evaluation: { overallBand: 6.5, activeTier: { tier: 1, detailLabel: 'API 1' } } as any,
      answers: []
    } as any);
    const current = await saveIeltsTestResult({
      id: 'comparison-current-score',
      mode: 'part1', timestamp: Date.now(), overallBand: 7.0,
      evaluation: { overallBand: 7.0, activeTier: { tier: 1, detailLabel: 'API 1' } } as any,
      answers: []
    } as any);
    await expect(compareIeltsAttempts(previous, current)).rejects.toThrow(/API 1:.*API 2:/i);
    const history = await getIeltsTestHistory();
    expect(history.find(item => item.id === previous.id)?.overallBand).toBe(6.5);
    expect(history.find(item => item.id === current.id)?.overallBand).toBe(7.0);
    expect(history.find(item => item.id === previous.id)?.evaluationError).toBeFalsy();
    expect(history.find(item => item.id === current.id)?.evaluationError).toBeFalsy();
  });

  it('preserves a valid saved band when a manual provider-specific re-evaluation fails', async () => {
    const previousEvaluation = {
      overallBand: 7.5,
      activeTier: { tier: 1, label: 'Online AI', detailLabel: 'API 1 · OpenAI' }
    };
    const record = await saveIeltsTestResult({
      id: 'existing-valid-band-after-retry',
      mode: 'part1',
      overallBand: 7.5,
      evaluation: previousEvaluation as any,
      evaluationError: null,
      answers: [{
        questionId: 'q1',
        part: 'part1',
        questionText: 'Where is your hometown?',
        transcript: 'My hometown is a coastal city with a busy harbour and several public parks.',
        durationSec: 18
      }]
    } as any);

    await expect(retryIeltsEvaluation(record, undefined, { providerChoice: 'secondary' }))
      .rejects.toThrow(/API 2 is not ready/i);

    const history = await getIeltsTestHistory();
    const reopened = history.find(item => item.id === record.id);
    expect(reopened?.overallBand).toBe(7.5);
    expect(reopened?.evaluation?.overallBand).toBe(7.5);
    expect(reopened?.evaluationError).toBeFalsy();
  });

  it('cleanJsonPayload extracts pure JSON from markdown code fences and extraneous text', () => {
    const rawWithFence = '```json\n{\n  "fluencyCoherenceBand": 7.0\n}\n```';
    expect(cleanJsonPayload(rawWithFence)).toBe('{\n  "fluencyCoherenceBand": 7.0\n}');

    const rawWithPrefix = 'Here is the evaluation:\n{\n  "test": 1\n}\nHope this helps!';
    expect(cleanJsonPayload(rawWithPrefix)).toBe('{\n  "test": 1\n}');
  });

  it('buildIeltsEvaluationPrompt builds strict IELTS band descriptors prompt with speech statistics', () => {
    const prompt = buildIeltsEvaluationPrompt({ answers: sampleAnswers });
    expect(prompt.system).toContain('IELTS Speaking Band Descriptors');
    expect(prompt.system).toContain('DO NOT INFLATE SCORES');
    expect(prompt.user).toContain('Overall WPM:');
    expect(prompt.user).toContain('Candidate Transcript: "My hometown is located');
    expect(prompt.user).toContain('Describe a memorable journey you took');
  });

  it('requests and parses LLM evaluation with mock OpenAI/Groq JSON response', async () => {
    const mockLlmResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              fluencyCoherenceBand: 7.0,
              lexicalResourceBand: 7.5,
              grammaticalRangeBand: 6.5,
              perCriterionComments: {
                fluency: 'Good speaking flow with natural discourse markers.',
                lexical: 'Used descriptive words like "vibrant" and "breathtaking".',
                grammar: 'Mixed simple and complex sentences with minor slips.'
              },
              corrections: [
                {
                  original: 'trip I took across',
                  corrected: 'journey I embarked on across',
                  explanation: 'More formal phrasing for narrative cohesion.'
                }
              ],
              vocabularyUpgrades: [
                {
                  original: 'green parks',
                  upgraded: 'verdant public spaces',
                  context: 'Enriches descriptive environmental vocabulary.'
                }
              ],
              modelAnswers: [
                {
                  question: 'Where is your hometown?',
                  band7ModelAnswer:
                    'My hometown is nestled in the northern mountains, renowned for its lively cultural scene.'
                }
              ],
              perAnswerFeedback: [
                {
                  questionId: 'q1',
                  bandEstimate: 7.0,
                  comment: 'Clear, direct answer with appropriate elaboration.'
                }
              ],
              topPriorities: [
                'Continue using natural discourse markers.',
                'Expand Part 2 narrative with deeper reflection.',
                'Refine complex sentence prepositions.'
              ]
            })
          }
        }
      ]
    };

    const mockTransport = async (opts: HttpOptions): Promise<HttpResponse> => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: mockLlmResponse,
      url: opts.url
    });

    const res = await requestLlmIeltsEvaluation({
      slotConfig: {
        slotId: 'llm_evaluator',
        providerId: 'openai_compat_eval',
        baseUrl: 'https://api.openai.com/v1',
        modelOrVoice: 'gpt-4o-mini'
      },
      apiKey: 'sk-test-key',
      answers: sampleAnswers,
      transport: mockTransport
    });

    expect(res.fluencyCoherenceBand).toBe(7.0);
    expect(res.lexicalResourceBand).toBe(7.5);
    expect(res.grammaticalRangeBand).toBe(6.5);
    expect(res.corrections).toHaveLength(1);
    expect(res.vocabularyUpgrades).toHaveLength(1);
    expect(res.modelAnswers).toHaveLength(1);
    expect(res.topPriorities).toHaveLength(3);
  });

  it('requires an online API and never falls back to offline IELTS evaluation', async () => {
    await saveSlotConfig({
      slotId: 'llm_evaluator',
      providerId: 'offline_rule_eval',
      baseUrl: 'offline://rule-evaluator',
      modelOrVoice: 'rule-based'
    });

    await expect(evaluateIeltsWithTierFallback({
      answers: sampleAnswers
    })).rejects.toBeInstanceOf(IeltsApiRequiredError);
  });

  it('evaluateIeltsWithTierFallback gives no score and says answers were too short when candidate speaks fewer than 15 words', async () => {
    await saveSlotConfig({
      slotId: 'llm_evaluator',
      providerId: 'openai_compat_eval',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'gpt-4o-mini'
    });
    await saveApiKey('llm_evaluator', 'openai_compat_eval', 'sk-test-live');
    await verifyEvaluator('openai_compat_eval');

    const shortAnswers: IeltsAnswerInput[] = [
      {
        questionId: 'q1',
        part: 1,
        question: 'Where is your hometown?',
        transcript: 'Just in London.',
        durationMs: 3000,
        confidence: 0.95
      }
    ];

    const shortResult = await evaluateIeltsWithTierFallback({
      answers: shortAnswers
    });

    expect(shortResult.overallBand).toBeNull();
    expect(shortResult.noScoreNotice).toContain('very short answers');
    expect(shortResult.confidenceLabel).toBe('no band score without AI evaluation');
    expect(shortResult.sessionMetrics.totalWords).toBe(3);
  });

  it('uses the verified secondary Evaluator API after the primary returns an authentication failure', async () => {
    await saveSlotConfig({
      slotId: 'llm_evaluator',
      providerId: 'gemini_eval',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelOrVoice: 'gemini-2.5-flash'
    });
    await saveApiKey('llm_evaluator', 'gemini_eval', 'primary-evaluator-key');
    await verifyEvaluator('gemini_eval');
    const secondaryEvaluatorConfig = { slotId: 'llm_evaluator' as const, providerId: 'openai_compat_eval', baseUrl: 'https://api.openai.com/v1', modelOrVoice: 'gpt-4o-mini' };
    const secondaryEvaluatorFingerprint = await createProviderVerificationFingerprint(secondaryEvaluatorConfig, 'secondary-evaluator-key');
    await saveSecondarySlotConfig('llm_evaluator', {
      providerId: 'openai_compat_eval',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'gpt-4o-mini',
      verified: true,
      testResult: { ok: true, latencyMs: 1, message: 'PASS — API 2', testedAt: Date.now(), verificationFingerprint: secondaryEvaluatorFingerprint ?? undefined }
    });
    await saveApiKey('llm_evaluator', 'openai_compat_eval', 'secondary-evaluator-key', 'secondary');

    const payload = {
      fluencyCoherenceBand: 6.5,
      lexicalResourceBand: 7,
      grammaticalRangeBand: 6.5,
      perCriterionComments: { fluency: 'Clear', lexical: 'Varied', grammar: 'Mostly accurate' },
      corrections: [],
      vocabularyUpgrades: [],
      modelAnswers: [],
      perAnswerFeedback: [],
      topPriorities: ['Improve linking', 'Extend examples', 'Check articles']
    };
    const attemptedUrls: string[] = [];
    const transport = async (opts: HttpOptions): Promise<HttpResponse> => {
      attemptedUrls.push(opts.url);
      if (opts.url.includes('generativelanguage.googleapis.com')) {
        return { url: opts.url, status: 401, headers: {}, data: { error: { message: 'Primary key rejected' } } };
      }
      return {
        url: opts.url, status: 200, headers: { 'content-type': 'application/json' },
        data: { choices: [{ message: { content: JSON.stringify(payload) } }] }
      };
    };

    const result = await evaluateIeltsWithTierFallback({ answers: sampleAnswers, transport });
    expect(attemptedUrls.some(url => url.includes('generativelanguage.googleapis.com'))).toBe(true);
    expect(attemptedUrls.some(url => url.includes('/chat/completions'))).toBe(true);
    expect(result.activeTier.providerId).toBe('openai_compat_eval');
    expect(result.activeTier.detailLabel).toContain('API 2');
    expect(result.overallBand).toBe(6.5);
  });

  it('does not automatically replay billable evaluation POSTs after provider 503 errors', async () => {
    await saveSlotConfig({
      slotId: 'llm_evaluator',
      providerId: 'gemini_eval',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      modelOrVoice: 'gemini-2.5-flash'
    });
    await saveApiKey('llm_evaluator', 'gemini_eval', 'sk-gemini-test');
    await verifyEvaluator('gemini_eval');

    let attempts = 0;
    const failingTransport = async (opts: HttpOptions): Promise<HttpResponse> => {
      attempts++;
      return {
        status: 503,
        headers: {},
        data: { error: { message: 'The model is overloaded. Please try again later.' } },
        url: opts.url
      };
    };

    await expect(
      evaluateIeltsWithTierFallback({
        answers: sampleAnswers,
        transport: failingTransport
      })
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LlmEvaluationFailureError);
      const llmErr = err as LlmEvaluationFailureError;
      expect(llmErr.reason).toContain('Google server overloaded (HTTP 503)');
      return true;
    });

    // POSTs are not replayed after ambiguous 5xx failures to avoid duplicate billable jobs.
    expect(attempts).toBe(1);

    // Diagnostics telemetry
    const telemetry = getLastLlmEvaluationTelemetry();
    expect(telemetry.error).toContain('503');

    const sessionLogs = getIeltsSessionLogs();
    const failureLog = sessionLogs.find((l) => l.event === 'LLM Evaluation');
    expect(failureLog).toBeDefined();
    expect(failureLog?.status).toBe('error');
    expect(failureLog?.error).toContain('503');
  });

  it('succeeds when explicit HTTP 429 rate limits recover within the configured retry limit', async () => {
    await saveSlotConfig({
      slotId: 'llm_evaluator',
      providerId: 'openai_compat_eval',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'gpt-4o-mini'
    });
    await saveApiKey('llm_evaluator', 'openai_compat_eval', 'sk-test-live');
    await verifyEvaluator('openai_compat_eval');

    let attempts = 0;
    const transientTransport = async (opts: HttpOptions): Promise<HttpResponse> => {
      attempts++;
      if (attempts <= 2) {
        return {
          status: 429,
          headers: {},
          data: { error: 'Rate limit exceeded' },
          url: opts.url
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  fluencyCoherenceBand: 7.5,
                  lexicalResourceBand: 7.0,
                  grammaticalRangeBand: 7.0
                })
              }
            }
          ]
        },
        url: opts.url
      };
    };

    const res = await evaluateIeltsWithTierFallback({
      answers: sampleAnswers,
      transport: transientTransport
    });

    expect(attempts).toBe(3);
    expect(res.overallBand).toBeGreaterThanOrEqual(6.5);
    expect(res.activeTier.tier).toBe(1);
    expect(res.activeTier.label).toBe('Online AI');
  });

  it('persists every answer as a draft to local storage as soon as recorded', async () => {
    await clearIeltsDraft();

    const plan = generateIeltsSessionPlan();
    plan.id = `session_llm_test_${plan.id}`;
    plan.part1Questions = plan.part1Questions.map((q) => ({ ...q, id: `llm_${q.id}` }));
    const controller = new IeltsSessionController({ mode: 'part1' });
    // Start an AI-provenance fixture plan before simulating the candidate's skip.
    await controller.startSession('part1', { plan });
    await controller.skipCurrentStep();

    const draft = await loadIeltsDraft();
    expect(draft).not.toBeNull();
    expect(draft?.completedAnswers).toHaveLength(1);
    expect(draft?.completedAnswers[0].transcript).toBe('[Question skipped by candidate]');
    expect(draft?.completedAnswers[0].wasSkipped).toBe(true);
    expect(typeof draft?.updatedAt).toBe('number');
  });

  it('shows result screen with exact reason, no score, and retry evaluation button when evaluation fails', async () => {
    const failedRecord = {
      id: 'test-failed-eval-1',
      timestamp: Date.now(),
      mode: 'part1' as const,
      overallBand: null,
      evaluation: null,
      evaluationError: 'Google server overloaded (HTTP 503)',
      answers: [
        {
          questionId: 'q1',
          part: 'part1' as const,
          questionText: 'Where are you from?',
          transcript: 'I am from a small coastal town.',
          durationSec: 15
        }
      ]
    };

    const container = document.createElement('div');
    let retryCalled = false;
    renderIeltsResultView(container, failedRecord, {
      onRetake: () => {},
      onBackToHistory: () => {},
      onRetryEvaluation: async () => {
        retryCalled = true;
      }
    });

    // Score is NOT produced
    const bandEl = container.querySelector('#result-overall-band');
    expect(bandEl?.textContent?.trim()).toBe('—');
    expect(container.textContent).toContain('No band score this time');

    // Exact reason is displayed
    const reasonEl = container.querySelector('#result-failure-reason');
    expect(reasonEl?.textContent).toContain('Google server overloaded (HTTP 503)');

    // Answers are preserved
    expect(container.textContent).toContain('I am from a small coastal town.');

    // Retry evaluation button is offered and clickable
    const retryBtn = container.querySelector<HTMLButtonElement>('#result-retry-eval-btn');
    expect(retryBtn).not.toBeNull();
    retryBtn?.click();
    expect(retryCalled).toBe(true);
  });

  it('history view offers retry evaluation button for tests without an evaluation and executes retry flow', async () => {
    await clearIeltsTestHistory();
    await saveSlotConfig({
      slotId: 'llm_evaluator',
      providerId: 'openai_compat_eval',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'gpt-4o-mini'
    });
    await saveApiKey('llm_evaluator', 'openai_compat_eval', 'sk-test-live');
    await verifyEvaluator('openai_compat_eval');

    await saveIeltsTestResult({
      id: 'test-un-eval-rec',
      mode: 'part1',
      overallBand: null,
      evaluation: null,
      evaluationError: 'OpenAI server rate limit exceeded (HTTP 429)',
      answers: [
        {
          questionId: 'q1',
          part: 'part1',
          questionText: 'Tell me about your job.',
          transcript: 'I work as a software engineer for educational apps.',
          durationSec: 20
        }
      ]
    });

    const mockRetryTransport = async () => ({
      status: 200,
      headers: {},
      url: 'https://api.openai.com/v1/chat/completions',
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                fluencyCoherenceBand: 7.5,
                lexicalResourceBand: 7.5,
                grammaticalRangeBand: 7.5,
                perCriterionComments: {
                  fluency: 'Fluent delivery with good coherence.',
                  lexical: 'Varied and precise vocabulary.',
                  grammar: 'Complex structures used accurately.'
                },
                corrections: [],
                vocabularyUpgrades: [],
                modelAnswers: [],
                topPriorities: ['Keep expanding complex arguments.']
              })
            }
          }
        ]
      }
    });

    const container = document.createElement('div');
    let retriedRecordId: string | null = null;

    await renderIeltsHistoryView(container, {
      onSelectResult: () => {},
      onBackToTest: () => {},
      onRetryEvaluation: async (rec) => {
        retriedRecordId = rec.id;
        await retryIeltsEvaluation(rec, mockRetryTransport);
      }
    });

    expect(container.textContent).toContain('Evaluation pending');
    expect(container.textContent).toContain('OpenAI server rate limit exceeded (HTTP 429)');

    const retryBtn = container.querySelector<HTMLButtonElement>('.history-retry-btn');
    expect(retryBtn).not.toBeNull();
    retryBtn?.click();
    await new Promise((r) => setTimeout(r, 50));

    expect(retriedRecordId).toBe('test-un-eval-rec');
    const history = await getIeltsTestHistory();
    expect(history[0].overallBand).toBe(7.5);
    expect(history[0].evaluationError).toBeNull();
  });

  it('never treats ASR confidence as an IELTS pronunciation score (A1-3)', async () => {
    await saveSlotConfig({
      slotId: 'llm_evaluator',
      providerId: 'openai_compat_eval',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'gpt-4o-mini'
    });
    await saveApiKey('llm_evaluator', 'openai_compat_eval', 'sk-test-live');
    await verifyEvaluator('openai_compat_eval');

    const answersWithoutConfidence: IeltsAnswerInput[] = [
      {
        questionId: 'q1',
        part: 1,
        question: 'Where is your hometown?',
        transcript:
          'My hometown is located in the northern region with many historic parks and museums.',
        durationMs: 12000,
        confidence: 0.99,
        tokens: [
          { word: 'My', startMs: 0, endMs: 200 },
          { word: 'hometown', startMs: 210, endMs: 650 }
        ]
      }
    ];

    const mockTransport = async (opts: HttpOptions): Promise<HttpResponse> => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                fluencyCoherenceBand: '8.0',
                lexicalResourceBand: 7.5,
                grammaticalRangeBand: 8.5,
                perCriterionComments: {
                  fluency: 'Effortless delivery.',
                  lexical: 'Precise vocabulary.',
                  grammar: 'Wide range of structures.'
                }
              })
            }
          }
        ]
      },
      url: opts.url
    });

    const res = await evaluateIeltsWithTierFallback({
      answers: answersWithoutConfidence,
      transport: mockTransport
    });

    expect(res.pronunciationBand).toBeNull();
    expect(res.pronunciationNotice.toLowerCase()).toContain('not assessed');
    expect(res.perCriterionComments.pronunciation.toLowerCase()).toContain('not assessed');
    // Overall average of (8.0 + 7.5 + 8.5) / 3 = 8.0 (not dragged down by a fake 6.5/7.5 pronunciation score!)
    expect(res.fluencyCoherenceBand).toBe(8.0);
    expect(res.lexicalResourceBand).toBe(7.5);
    expect(res.grammaticalRangeBand).toBe(8.5);
    expect(res.overallBand).toBe(8.0);
    expect(res.confidenceLabel).toContain('not an official IELTS score');
  });

  it('treats missing or invalid LLM band as a failed evaluation instead of inventing 5.5, showing reason and offering retry (A2-4)', async () => {
    await saveSlotConfig({
      slotId: 'llm_evaluator',
      providerId: 'openai_compat_eval',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'gpt-4o-mini'
    });
    await saveApiKey('llm_evaluator', 'openai_compat_eval', 'sk-test-live');
    await verifyEvaluator('openai_compat_eval');

    // Case 1: missing lexicalResourceBand
    const missingBandTransport = async (opts: HttpOptions): Promise<HttpResponse> => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                fluencyCoherenceBand: 7.0,
                grammaticalRangeBand: 6.5
              })
            }
          }
        ]
      },
      url: opts.url
    });

    let failureReason = '';
    await expect(
      evaluateIeltsWithTierFallback({
        answers: sampleAnswers,
        transport: missingBandTransport
      })
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(LlmEvaluationFailureError);
      const llmErr = err as LlmEvaluationFailureError;
      failureReason = llmErr.reason;
      expect(llmErr.reason).toContain('lexicalResourceBand');
      return true;
    });

    // Case 2: out-of-range band (e.g. 12.0)
    const invalidRangeTransport = async (opts: HttpOptions): Promise<HttpResponse> => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                fluencyCoherenceBand: 7.0,
                lexicalResourceBand: 7.0,
                grammaticalRangeBand: 12.0
              })
            }
          }
        ]
      },
      url: opts.url
    });

    await expect(
      evaluateIeltsWithTierFallback({
        answers: sampleAnswers,
        transport: invalidRangeTransport
      })
    ).rejects.toThrow(/grammaticalRangeBand/);

    // Verify UI displays the failure reason and offers Retry without inventing 5.5
    const failedRecord = await saveIeltsTestResult({
      id: 'test-missing-band-rec',
      mode: 'part1',
      overallBand: null,
      evaluation: null,
      evaluationError: failureReason,
      answers: [
        {
          questionId: 'q1',
          part: 'part1',
          questionText: 'Where is your hometown?',
          transcript: sampleAnswers[0].transcript,
          durationSec: 12
        }
      ]
    });

    const container = document.createElement('div');
    renderIeltsResultView(container, failedRecord, {
      onRetake: () => {},
      onBackToHistory: () => {}
    });

    expect(container.querySelector('#result-overall-band')?.textContent?.trim()).toBe('—');
    expect(container.querySelector('#result-failure-reason')?.textContent).toContain(
      'lexicalResourceBand'
    );
    expect(container.querySelector('#result-retry-eval-btn')).not.toBeNull();
  });

  it('preserves an unrelated active IELTS draft when retry evaluation succeeds or fails', async () => {
    const plan = generateIeltsSessionPlan();
    const draft = {
      mode: 'part1' as const,
      plan,
      currentStepIndex: 2,
      candidateNotes: 'An unrelated in-progress session',
      completedAnswers: [],
      updatedAt: Date.now()
    };
    const record = {
      id: 'retry-preserves-active-draft',
      mode: 'part1' as const,
      overallBand: null,
      evaluation: null,
      answers: [{
        questionId: 'q1',
        part: 'part1' as const,
        questionText: 'Describe your hometown.',
        transcript: 'My hometown is a lively place with several parks and cultural attractions.',
        durationSec: 18
      }]
    };

    await saveSlotConfig({
      slotId: 'llm_evaluator',
      providerId: 'openai_compat_eval',
      baseUrl: 'https://api.openai.com/v1',
      modelOrVoice: 'gpt-4o-mini'
    });
    await saveApiKey('llm_evaluator', 'openai_compat_eval', 'sk-test-live');
    await verifyEvaluator('openai_compat_eval');
    const saved = await saveIeltsTestResult(record);
    await saveIeltsDraft(draft);

    const successTransport = async (opts: HttpOptions): Promise<HttpResponse> => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      url: opts.url,
      data: { choices: [{ message: { content: JSON.stringify({
        fluencyCoherenceBand: 6.5,
        lexicalResourceBand: 7,
        grammaticalRangeBand: 6.5,
        perCriterionComments: { fluency: 'Clear', lexical: 'Varied', grammar: 'Mostly accurate' },
        corrections: [], vocabularyUpgrades: [], modelAnswers: [],
        perAnswerFeedback: [], topPriorities: ['Extend answers']
      }) } }] }
    });

    await retryIeltsEvaluation(saved, successTransport);
    expect(await loadIeltsDraft()).toMatchObject({
      mode: 'part1',
      currentStepIndex: 2,
      candidateNotes: 'An unrelated in-progress session'
    });

    await saveSlotConfig({
      slotId: 'llm_evaluator',
      providerId: 'offline_rule_eval',
      baseUrl: 'offline://rule-evaluator',
      modelOrVoice: 'rule-based'
    });
    const failedRecord = await saveIeltsTestResult({
      ...record,
      id: 'retry-failure-preserves-active-draft'
    });
    await saveIeltsDraft(draft);
    await expect(retryIeltsEvaluation(failedRecord)).rejects.toBeInstanceOf(IeltsApiRequiredError);
    expect(await loadIeltsDraft()).toMatchObject({
      mode: 'part1',
      currentStepIndex: 2,
      candidateNotes: 'An unrelated in-progress session'
    });
  });

});
