import { Capacitor } from '@capacitor/core';
import { getPreset, SLOT_DEFINITIONS, SLOT_ORDER } from '../config/providers';
import { APP_VERSION } from '../config/appVersion';
import { checkForSpeakCoachUpdate, downloadSpeakCoachUpdate, installSpeakCoachUpdate, type SpeakCoachUpdate } from '../services/appUpdater';
import type { AllSlotsConfig, AuthStyle, ConnectionTestResult, SlotConfig, SlotId } from '../config/types';
import { testSlotConnection, testAndPersistSlotAccount, persistSlotAccountTestResult, testSlotAccountsSequentially, shouldPersistSlotVerification, describeConnectionTestFailure } from '../services/connectionTester';
import { networkMonitor } from '../services/networkMonitor';
import { getProviderAccountHealth } from '../services/providerHealth';
import { isOnlineProviderVerified } from '../services/slotConnectionStatus';
import {
  detectProviderUrlMismatch,
  getCustomProviderIdForSlot
} from '../services/customEndpointHelper';
import { fetchAvailableModels } from '../services/modelFetchService';
import { fetchAvailableTtsVoices } from '../services/ttsVoiceService';
import { clearGeminiLanguageFailures, clearPreloadedSentenceAudio, previewTtsVoice } from '../services/ttsService';
import { clearActiveShadowingAudioStore } from '../services/shadowingAudioStore';
import type { GlobalTierSummary } from '../services/tierManager';
import { loadApiKeyStrict, saveApiKey } from '../storage/keyStore';
import { getAppSettingsRecoveryNotices, loadAppSettings, saveAppSettings } from '../storage/appSettings';
import { setThemePreference } from '../services/themeManager';
import { showSetupGuide, applyAppLanguage } from './OnboardingView';
import { applyLanguageToDocument } from '../services/appLanguage';
import { confirmInApp } from './confirmDialog';
import { showToast } from './toast';
import { createBackup, downloadBackupFile, parseBackupJsonText, readBackupFile, restoreBackup, type BackupKind } from '../services/dataBackup';
import { isNativeBackupImportAvailable, selectNativeBackupFile } from '../services/nativeBackupImport';
import { getIeltsQuestionStoreRecoveryNotices } from '../services/ieltsQuestionSetStore';
import { getIeltsHistoryRecoveryNotices } from '../storage/ieltsHistoryStore';
import {
  clearSlotConnectionTestResult,
  loadAllConnectionTestResults,
  loadAllSlotsConfig,
  loadSlotConnectionTestResult,
  getStorageRecoveryNotices,
  type PersistedConnectionTestResult,
  saveSlotConfig,
  saveAllSlotsConfig,
  saveSlotConnectionTestResult,
  saveSecondarySlotConfig
} from '../storage/localStore';

const lastTestResults = new Map<SlotId, ConnectionTestResult>();
const dismissedVerificationErrors = new Set<SlotId>();
let settingsProviderTestRunning = false;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function renderSettingsView(
  container: HTMLElement,
  configs: AllSlotsConfig,
  summary: GlobalTierSummary,
  _onSettingsUpdated: () => Promise<void>,
  onOpenDiagnostics?: () => void
): Promise<void> {
  const appSettings = await loadAppSettings();
  const keyStorageLabel = Capacitor.isNativePlatform() ? 'Securely stored on this device' : 'Browser storage (not encrypted)';
  const browserKeyStorageNoticeHtml = Capacitor.isNativePlatform()
    ? ''
    : '<aside class="offline-quality-notice" role="note"><strong>Browser API-key storage</strong><p>In a desktop browser, API keys are stored in browser app storage and are not encrypted by Android Keystore. Use a trusted personal device and avoid shared browsers. Android installs use Android Keystore.</p></aside>';
  const persistedResults = await loadAllConnectionTestResults();
  const storageRecoveryNotices = [
    ...getStorageRecoveryNotices(),
    ...getAppSettingsRecoveryNotices(),
    ...getIeltsQuestionStoreRecoveryNotices(),
    ...getIeltsHistoryRecoveryNotices()
  ];
  const recoveryNoticeHtml = storageRecoveryNotices.length
    ? `<aside class="offline-quality-notice" role="alert" aria-label="Data recovery notice"><strong>Data recovery notice</strong><ul>${storageRecoveryNotices.map(message => `<li>${escapeHtml(message)}</li>`).join('')}</ul><p>Keep the app installed and do not clear its data until you have reviewed the preserved recovery copies. Export any accessible current data separately.</p></aside>`
    : '';
  for (const slotId of SLOT_ORDER) {
    if (persistedResults[slotId] && !lastTestResults.has(slotId)) {
      lastTestResults.set(slotId, persistedResults[slotId]!);
    }
  }

  const keyStorageReadErrors = new Set<string>();
  const readKeyForSettings = async (slotId: SlotId, providerId: string, account: 'primary' | 'secondary' = 'primary'): Promise<string> => {
    const errorKey = `${slotId}|${providerId}|${account}`;
    try {
      return await loadApiKeyStrict(slotId, providerId, account);
    } catch {
      keyStorageReadErrors.add(errorKey);
      return '';
    }
  };

  const keysBySlot: Record<SlotId, string> = {
    voice_tts: await readKeyForSettings('voice_tts', configs.voice_tts.providerId),
    pronunciation_scoring: await readKeyForSettings('pronunciation_scoring', configs.pronunciation_scoring.providerId),
    ielts_stt: await readKeyForSettings('ielts_stt', configs.ielts_stt.providerId),
    llm_evaluator: await readKeyForSettings('llm_evaluator', configs.llm_evaluator.providerId),
    llm_generator: await readKeyForSettings('llm_generator', configs.llm_generator.providerId),
    llm_translation: await readKeyForSettings('llm_translation', configs.llm_translation.providerId)
  };

  const secondaryKeysBySlot: Record<SlotId, string> = {
    voice_tts: configs.voice_tts.secondary ? await readKeyForSettings('voice_tts', configs.voice_tts.secondary.providerId, 'secondary') : '',
    pronunciation_scoring: configs.pronunciation_scoring.secondary ? await readKeyForSettings('pronunciation_scoring', configs.pronunciation_scoring.secondary.providerId, 'secondary') : '',
    ielts_stt: configs.ielts_stt.secondary ? await readKeyForSettings('ielts_stt', configs.ielts_stt.secondary.providerId, 'secondary') : '',
    llm_evaluator: configs.llm_evaluator.secondary ? await readKeyForSettings('llm_evaluator', configs.llm_evaluator.secondary.providerId, 'secondary') : '',
    llm_generator: configs.llm_generator.secondary ? await readKeyForSettings('llm_generator', configs.llm_generator.secondary.providerId, 'secondary') : '',
    llm_translation: configs.llm_translation.secondary ? await readKeyForSettings('llm_translation', configs.llm_translation.secondary.providerId, 'secondary') : ''
  };

  const hasConfiguredOnlineAccount = SLOT_ORDER.some((slotId) => {
    const primary = getPreset(slotId, configs[slotId].providerId);
    const secondary = configs[slotId].secondary ? getPreset(slotId, configs[slotId].secondary!.providerId) : null;
    return primary.tier !== 3 || Boolean(secondary && secondary.tier !== 3);
  });

  const unreadableApiKeyWarnings = Array.from(keyStorageReadErrors).map((entry) => {
    const [slotIdRaw, providerId, account] = entry.split('|');
    const slotId = slotIdRaw as SlotId;
    return `${SLOT_DEFINITIONS[slotId].title} — ${account} key for ${providerId} could not be read from secure storage.`;
  });
  const apiKeyRecoveryNoticeHtml = unreadableApiKeyWarnings.length
    ? `<aside class="offline-quality-notice" role="alert" aria-label="API key recovery notice"><strong>Saved API key needs recovery</strong><ul>${unreadableApiKeyWarnings.map(escapeHtml).map(message => `<li>${message}</li>`).join('')}</ul><p>Do not save an empty value for these providers. Restore the key from an AI Settings backup, enter a replacement key, or switch providers. SpeakCoach will not silently erase the unreadable saved value.</p></aside>`
    : '';

  const accountHealthBySlot = new Map<SlotId, {
    primary: Awaited<ReturnType<typeof getProviderAccountHealth>>;
    secondary: Awaited<ReturnType<typeof getProviderAccountHealth>>;
  }>();
  for (const slotId of SLOT_ORDER) {
    accountHealthBySlot.set(slotId, {
      primary: await getProviderAccountHealth(slotId, 'primary'),
      secondary: await getProviderAccountHealth(slotId, 'secondary')
    });
  }

  const slotDisplayCopy: Record<SlotId, { title: string; purpose: string }> = {
    voice_tts: { title: 'Voice', purpose: 'Speak sentences and examiner questions' },
    pronunciation_scoring: { title: 'Shadowing feedback', purpose: 'Check spoken words and timing' },
    ielts_stt: { title: 'Speech recognition', purpose: 'Turn IELTS answers into text' },
    llm_evaluator: { title: 'Smart scoring', purpose: 'Evaluate IELTS answers and give feedback' },
    llm_generator: { title: 'Question generator', purpose: 'Create practice questions and sentences' },
    llm_translation: { title: 'Translation & grammar', purpose: 'Translate and explain the current sentence' }
  };

  const cardsHtml = SLOT_ORDER.map((slotId) => {
    const def = SLOT_DEFINITIONS[slotId];
    const displayCopy = slotDisplayCopy[slotId];
    const slotCfg = configs[slotId];
    const preset = getPreset(slotId, slotCfg.providerId);
    const resolved = summary.slots[slotId];
    const currentKey = keysBySlot[slotId] ?? '';
    const storedLastTest = lastTestResults.get(slotId);
    const lastTest = storedLastTest?.providerId === slotCfg.providerId ? storedLastTest : undefined;
    const apiRequiredOfflineSelected = (slotId === 'llm_evaluator' || slotId === 'llm_translation') && preset.tier === 3;
    const slotOnlineVerified = isOnlineProviderVerified(lastTest, slotCfg.secondary);
    const secondaryPreset = slotCfg.secondary ? getPreset(slotId, slotCfg.secondary.providerId) : null;
    const secondarySuggestions = secondaryPreset ? (secondaryPreset.modelSuggestions || [secondaryPreset.defaultModelOrVoice]) : [];
    const secondaryIsCustom = secondaryPreset?.id.startsWith('custom_openai_') ?? false;
    const secondarySameModelAsPrimary = !!slotCfg.secondary && slotCfg.secondary.providerId === slotCfg.providerId && slotCfg.secondary.modelOrVoice.trim() === slotCfg.modelOrVoice.trim();
    const secondaryTestResult = slotCfg.secondary?.testResult;
    const accountHealth = accountHealthBySlot.get(slotId);
    const primaryAccountReady = lastTest?.ok === true && lastTest.tier !== 3 && !accountHealth?.primary;
    const secondaryAccountReady = !!slotCfg.secondary && slotCfg.secondary.verified === true && secondaryTestResult?.ok === true && !accountHealth?.secondary;
    const bothConfiguredApisReady = !!slotCfg.secondary && primaryAccountReady && secondaryAccountReady;
    const mixedApiReadiness = !!slotCfg.secondary && primaryAccountReady !== secondaryAccountReady;
    let slotStatus = apiRequiredOfflineSelected
      ? 'api-required'
      : resolved.label !== 'Online AI' && (lastTest?.ok || resolved.reason?.toLowerCase().includes('re-test'))
        ? 'needs-retest'
        : resolved.label !== 'Online AI' && resolved.reason?.toLowerCase().includes('cooling down')
          ? 'cooldown'
          : resolved.label === 'Online AI' && /needs a successful connection re-test|verification is missing|expired|no longer matches/i.test(resolved.reason ?? '')
            ? 'ready-degraded'
            : resolved.label === 'Online AI' && resolved.reason?.includes('cooling down')
              ? 'ready-cooldown'
              : slotOnlineVerified && resolved.label === 'Online AI'
                ? 'ready'
            : lastTest
              ? 'error'
              : resolved.label === 'Online AI'
                ? 'ready'
                : preset.requiresKey && !currentKey.trim()
                  ? 'needs-key'
                  : preset.requiresKey
                    ? 'not-tested'
                    : 'offline-ready';
    if (bothConfiguredApisReady || mixedApiReadiness) slotStatus = 'ready';
    const badgeClass = slotStatus === 'ready' || slotStatus === 'ready-degraded' || slotStatus === 'ready-cooldown' ? 'online' : slotStatus === 'error' || slotStatus === 'needs-retest' ? 'error' : 'offline';
    const badgeLabel = slotStatus === 'ready' ? 'Ready' : slotStatus === 'ready-degraded' ? `Ready · ${resolved.reason?.startsWith('API 1') ? 'API 1 needs re-test' : 'API 2 needs re-test'}` : slotStatus === 'ready-cooldown' ? `Ready · ${resolved.reason?.startsWith('API 1') ? 'API 1 cooling down' : 'API 2 cooling down'}` : slotStatus === 'needs-retest' ? 'Needs re-test' : slotStatus === 'cooldown' ? 'Cooling down' : slotStatus === 'error' ? 'Error' : slotStatus === 'needs-key' ? 'API key needed' : slotStatus === 'offline-ready' ? 'Offline ready' : slotStatus === 'api-required' ? 'API required' : 'Not tested';
    const isCustom = preset.id.startsWith('custom_openai_');
    const secondaryStatusClass = secondaryTestResult
      ? (secondaryTestResult.ok ? 'pass' : 'fail')
      : (slotCfg.secondary?.verified ? 'pass' : 'info');
    const secondaryStatusText = secondaryTestResult
      ? `${escapeHtml(secondaryTestResult.message)} · <span class="settings-tested-time">Tested: ${new Date(secondaryTestResult.testedAt).toLocaleTimeString()}</span>`
      : (slotCfg.secondary?.verified ? 'PASS — Verified (test details unavailable)' : 'Not tested');
    const renderAccountStatus = (
      account: 'primary' | 'secondary',
      providerName: string,
      ready: boolean,
      result: Pick<ConnectionTestResult, 'ok' | 'message'> | undefined,
      health: Awaited<ReturnType<typeof getProviderAccountHealth>>
    ): string => {
      const label = account === 'primary' ? 'API 1' : 'API 2';
      if (ready) return `<div class="status-box pass" id="${account === 'primary' ? `status-${slotId}` : `secondary-status-${slotId}`}">${label} (${escapeHtml(providerName)}): Ready</div>`;
      const healthText = health
        ? `${health.state === 'cooldown' ? 'Cooling down' : 'Needs re-test'} — ${health.reason}`
        : result
          ? `Error — ${result.message}`
          : account === 'primary'
            ? (resolved.reason ?? 'Not tested')
            : secondaryStatusText;
      const statusClass = health?.state === 'cooldown' ? 'info' : 'fail';
      return `<div class="status-box ${statusClass}" id="${account === 'primary' ? `status-${slotId}` : `secondary-status-${slotId}`}">${label} (${escapeHtml(providerName)}): ${escapeHtml(healthText)}</div>`;
    };
    const secondaryStatusHtml = bothConfiguredApisReady
      ? ''
      : mixedApiReadiness && secondaryPreset
        ? renderAccountStatus('secondary', secondaryPreset.name, secondaryAccountReady, secondaryTestResult, accountHealth?.secondary ?? null)
        : `<div class="status-box ${secondaryStatusClass}" id="secondary-status-${slotId}">API 2: ${secondaryStatusText}</div>`;
    const showVoiceInput = slotId === 'voice_tts' && preset.id !== 'android_native_tts';
    const mismatchInfo = detectProviderUrlMismatch(slotCfg);
    const secondaryMismatchInfo = secondaryPreset ? detectProviderUrlMismatch({ slotId, providerId: secondaryPreset.id, baseUrl: slotCfg.secondary?.baseUrl || secondaryPreset.defaultBaseUrl, endpointPathOverride: slotCfg.secondary?.endpointPathOverride }) : { mismatch: false, reason: undefined as string | undefined };

    const optionsHtml = def.providers
      .map(
        (p) =>
          `<option value="${escapeHtml(p.id)}" ${p.id === preset.id ? 'selected' : ''} ${(slotId === 'llm_evaluator' || slotId === 'llm_translation') && p.tier === 3 ? 'disabled' : ''}>${escapeHtml(
            p.name
          )}</option>`
      )
      .join('');

    // Compact model menu suggestions
    const suggestions = preset.modelSuggestions || [preset.defaultModelOrVoice];

    // Either API account in another capability slot can be used as a key source.
    const copyKeySources = SLOT_ORDER
      .filter((otherSlotId) => otherSlotId !== slotId)
      .flatMap((otherSlotId) => {
        const otherDef = SLOT_DEFINITIONS[otherSlotId];
        return [
          ...((keysBySlot[otherSlotId] ?? '').trim()
            ? [{ slotId: otherSlotId, account: 'primary' as const, label: `From ${otherDef.title} (API 1)` }]
            : []),
          ...((secondaryKeysBySlot[otherSlotId] ?? '').trim()
            ? [{ slotId: otherSlotId, account: 'secondary' as const, label: `From ${otherDef.title} (API 2)` }]
            : [])
        ];
      });
    const copyKeyOptionsHtml = copyKeySources
      .map((source) => `<option value="${source.slotId}|${source.account}">${escapeHtml(source.label)}</option>`)
      .join('');
    const copyKeyPickerOptionsHtml = copyKeySources
      .map((source, index) => `<button type="button" class="provider-picker-option ${index === 0 ? 'active' : ''}" data-copy-key-source="${source.slotId}|${source.account}">${escapeHtml(source.label)}</button>`)
      .join('');
    // API 2 can reuse a key from either account of another capability slot.
    const secondaryCopyKeySources = SLOT_ORDER
      .filter((otherSlotId) => otherSlotId !== slotId)
      .flatMap((otherSlotId) => {
        const otherDef = SLOT_DEFINITIONS[otherSlotId];
        const primaryKey = keysBySlot[otherSlotId] ?? '';
        const secondaryKey = secondaryKeysBySlot[otherSlotId] ?? '';
        return [
          ...(primaryKey.trim() ? [{ slotId: otherSlotId, account: 'primary' as const, label: `From ${otherDef.title} (API 1)` }] : []),
          ...(secondaryKey.trim() ? [{ slotId: otherSlotId, account: 'secondary' as const, label: `From ${otherDef.title} (API 2)` }] : [])
        ];
      });
    const secondaryCopyKeyOptionsHtml = secondaryCopyKeySources
      .map((source) => `<option value="${source.slotId}|${source.account}">${escapeHtml(source.label)}</option>`)
      .join('');
    const secondaryCopyKeyPickerOptionsHtml = secondaryCopyKeySources
      .map((source, index) => `<button type="button" class="provider-picker-option ${index === 0 ? 'active' : ''}" data-secondary-copy-key-source="${source.slotId}|${source.account}">${escapeHtml(source.label)}</button>`)
      .join('');

    const statusHtml = bothConfiguredApisReady
      ? `<div class="status-box pass" id="status-${slotId}">Ready</div>`
      : mixedApiReadiness && secondaryPreset
        ? renderAccountStatus('primary', preset.name, primaryAccountReady, lastTest, accountHealth?.primary ?? null)
        : apiRequiredOfflineSelected
          ? `<div class="status-box info" id="status-${slotId}" style="${dismissedVerificationErrors.has(slotId) ? 'display:none;' : ''}">${slotId === 'llm_translation' ? 'Translation requires an online AI API. No offline translation engine is available.' : 'IELTS evaluation requires an online AI API. Offline IELTS evaluation is not available.'}</div>`
          : ['needs-retest', 'cooldown', 'ready-degraded', 'ready-cooldown'].includes(slotStatus) && resolved.reason
            ? `<div class="status-box ${slotStatus === 'needs-retest' ? 'fail' : 'info'}" id="status-${slotId}" style="${dismissedVerificationErrors.has(slotId) ? 'display:none;' : ''}">${escapeHtml(resolved.reason)}</div>`
            : lastTest
              ? `<div class="status-box ${lastTest.ok ? 'pass' : 'fail'}" id="status-${slotId}" style="${dismissedVerificationErrors.has(slotId) ? 'display:none;' : ''}">
                   ${escapeHtml(lastTest.message)}${ 
                     typeof (lastTest as PersistedConnectionTestResult).timestamp === 'number'
                       ? ` · <span class="settings-tested-time">Tested: ${new Date(
                           (lastTest as PersistedConnectionTestResult).timestamp
                         ).toLocaleTimeString()}</span>`
                       : ''
                   }
                 </div>`
              : `<div class="status-box info" id="status-${slotId}" style="${dismissedVerificationErrors.has(slotId) ? 'display:none;' : ''}">
                   ${escapeHtml(resolved.reason ?? `Active: ${resolved.detailLabel}`)}
                 </div>`;
    const showVerificationActions = !lastTest?.ok && !dismissedVerificationErrors.has(slotId);
    const verificationActionsHtml = `<div class="btn-row verification-error-actions" id="verification-actions-${slotId}" style="display:${showVerificationActions ? 'flex' : 'none'};gap:8px;margin-top:6px;">
         <button type="button" class="btn btn-secondary settings-verify-action" data-ignore-verification-error="${slotId}">Dismiss error</button>
       </div>`;

    return `
      <details class="card settings-accordion" data-slot-card="${slotId}">
        <summary class="settings-accordion-summary">
          <span class="settings-accordion-heading">
            <span class="card-title">${escapeHtml(displayCopy.title)}</span>
            <span class="card-subtitle">${escapeHtml(displayCopy.purpose)}</span>
          </span>
          <span class="settings-accordion-meta">
            <span class="tier-badge ${badgeClass} settings-slot-status" id="badge-${slotId}" data-slot-status="${slotStatus}">
              <span class="tier-dot"></span>
              ${badgeLabel}
            </span>
            <span class="settings-chevron" aria-hidden="true">⌄</span>
          </span>
        </summary>
        <div class="settings-accordion-content">
        <div class="settings-api-section-heading"><span>API 1</span><small>Primary provider</small></div>
        <div class="form-grid">
          <div class="form-field">
            <label class="form-label" for="provider-${slotId}">Provider</label>
            <select class="form-select provider-native-select" id="provider-${slotId}" data-slot="${slotId}" aria-hidden="true" tabindex="-1">
              ${optionsHtml}
            </select>
            <div class="provider-picker" id="provider-picker-${slotId}">
              <button type="button" class="provider-picker-trigger" id="provider-trigger-${slotId}" aria-expanded="false">
                <span>${escapeHtml(preset.name)}</span><span class="provider-picker-chevron">⌄</span>
              </button>
              <div class="provider-picker-options" id="provider-options-${slotId}" hidden>
                <p class="card-subtitle provider-picker-help">After selecting a provider and adding its API key, tap <strong>Test API 1</strong> below. Wait for a successful result before using online features. Test API 2 separately for a secondary provider.</p>
                ${def.providers.map((p) => `<button type="button" class="provider-picker-option ${p.id === preset.id ? 'active' : ''}" data-provider-id="${escapeHtml(p.id)}" ${((slotId === 'llm_evaluator' || slotId === 'llm_translation') && p.tier === 3) ? 'disabled' : ''}>${escapeHtml(p.name)}</button>`).join('')}
              </div>
            </div>
          </div>

          <div class="form-field settings-baseurl-field">
            <label class="form-label" for="baseurl-${slotId}">Base URL</label>
            <input
              type="url"
              class="form-input settings-baseurl-input"
              id="baseurl-${slotId}"
              value="${escapeHtml(slotCfg.baseUrl || preset.defaultBaseUrl)}"
              placeholder="${escapeHtml(preset.baseUrlPlaceholder)}"
              ${preset.tier === 3 ? 'disabled' : ''}
            />
            <div
              class="status-box fail settings-mismatch-warning"
              id="mismatch-warning-${slotId}"
              style="${mismatchInfo.mismatch ? '' : 'display: none;'}"
            >
              <div id="mismatch-warning-text-${slotId}" class="settings-mismatch-copy">
                ${escapeHtml(mismatchInfo.reason ?? '')}
              </div>
              <button
                type="button"
                class="btn btn-secondary settings-switch-custom-btn"
                id="switch-custom-btn-${slotId}"
              >
                Switch to Custom (OpenAI-compatible)
              </button>
            </div>
          </div>

          <div class="form-field">
            <label class="form-label settings-field-label" for="key-${slotId}">
              API Key ${preset.requiresKey ? `(${keyStorageLabel})` : '(Offline — no key needed)'}
            </label>
            <input
              type="password"
              class="form-input"
              id="key-${slotId}"
              value=""
              placeholder="${currentKey ? 'Key already stored securely. Leave blank to keep it, or type a replacement.' : (preset.requiresKey ? 'Enter your API key...' : 'No API key needed')}"
              autocomplete="off"
              ${preset.requiresKey ? '' : 'disabled'}
            />
            ${preset.requiresKey && copyKeyOptionsHtml ? `
              <div class="settings-copy-key-field">
                <label class="form-label" for="copy-key-source-${slotId}">Or copy from</label>
                <select class="form-select provider-native-select" id="copy-key-source-${slotId}" aria-hidden="true" tabindex="-1">${copyKeyOptionsHtml}</select>
                <div class="settings-copy-key">
                  <div class="provider-picker copy-key-provider-picker" id="copy-key-picker-${slotId}">
                    <button type="button" class="provider-picker-trigger" id="copy-key-trigger-${slotId}" aria-expanded="false"><span>${escapeHtml(copyKeySources[0]?.label ?? 'Choose source')}</span><span class="provider-picker-chevron">⌄</span></button>
                    <div class="provider-picker-options" id="copy-key-options-${slotId}" hidden>${copyKeyPickerOptionsHtml}</div>
                  </div>
                  <button type="button" class="btn btn-secondary settings-copy-key-btn" id="copy-key-btn-${slotId}">Copy API key</button>
                </div>
              </div>` : ''}
          </div>
${preset.id === 'freetts_tts' ? '' : `          <div class="form-field">
            <div class="settings-field-heading">
              <label class="form-label settings-field-label" for="model-${slotId}">
                ${escapeHtml(preset.modelFieldLabel)}
              </label>
              ${
                preset.tier !== 3
                  ? `<button type="button" class="btn btn-secondary settings-fetch-models-btn" id="fetch-models-btn-${slotId}">
                       Fetch models
                     </button>`
                  : ''
              }
            </div>
            <input
              type="text"
              class="form-input"
              id="model-${slotId}"
              value="${escapeHtml(slotCfg.modelOrVoice)}"
              placeholder="${escapeHtml(preset.defaultModelOrVoice)}"
              autocomplete="off"
            />
            <div class="model-picker-dropdown">
              <button type="button" class="model-picker-trigger" aria-expanded="false">Browse available models</button>
              <div class="model-picker-options" id="models-list-${slotId}" hidden>
                ${suggestions.map((model) => `<button type="button" class="model-option" data-model-value="${escapeHtml(model)}">${escapeHtml(model)}</button>`).join('')}
              </div>
            </div>
            <div id="fetch-models-msg-${slotId}" style="display: none;" class="settings-fetch-models-message"></div>

            ${slotId === 'pronunciation_scoring' || slotId === 'ielts_stt' ? `<p class="card-subtitle">This slot requires a Speech-to-Text endpoint (audio → text), normally <code>/audio/transcriptions</code> for OpenAI-compatible APIs. A text-only chat model is not sufficient.</p>` : ''}
          </div>`}



          ${
            slotId === 'voice_tts'
              ? `<div class="form-field" id="tts-voice-container-${slotId}" style="${showVoiceInput ? '' : 'display: none;'}">
                  <label class="form-label" for="custom-voice-${slotId}">Voice (choose from the available list or enter a custom name)</label>
                  <input type="text" class="form-input" id="custom-voice-${slotId}" value="${escapeHtml(slotCfg.customTtsVoice ?? '')}" placeholder="${preset.id === 'freetts_tts' ? 'en-US-JennyNeural' : preset.id === 'groq_tts' ? 'troy' : 'Choose or enter a voice name'}" autocomplete="off" />
                  <div class="voice-picker-dropdown">
                    <div class="btn-row">${preset.id === 'groq_tts' || preset.id === 'freetts_tts' ? '' : `<button type="button" class="btn btn-secondary settings-fetch-models-btn" id="fetch-voices-btn-${slotId}">Load available voices</button>`}<button type="button" class="btn btn-secondary" id="preview-voice-btn-${slotId}">Preview voice</button></div>
                    <div class="model-picker-options" id="voices-list-${slotId}" hidden></div>
                    <div id="preview-voice-msg-${slotId}" class="settings-fetch-models-message" role="status" aria-live="polite" hidden></div>
                    <div id="fetch-voices-msg-${slotId}" class="settings-fetch-models-message" role="status" aria-live="polite" hidden></div>
                  </div>
                </div>`
              : ''
          }


          <details class="advanced-provider-settings" id="advanced-auth-${slotId}" style="${isCustom ? '' : 'display:none;'}">
            <summary>Custom provider authentication and endpoint</summary>
            <div class="advanced-provider-fields"><div class="form-field" id="custom-auth-container-${slotId}" style="${isCustom ? '' : 'display: none;'}">
            <label class="form-label" for="authstyle-${slotId}">Authentication Style</label>
            <select class="form-select" id="authstyle-${slotId}">
              <option value="bearer" ${(slotCfg.authStyle ?? 'bearer') === 'bearer' ? 'selected' : ''}>Bearer Header (Authorization: Bearer &lt;key&gt;)</option>
              <option value="custom_header" ${slotCfg.authStyle === 'custom_header' ? 'selected' : ''}>Custom Header Name (e.g. X-API-Key)</option>
              <option value="query_param" ${slotCfg.authStyle === 'query_param' ? 'selected' : ''}>Query Parameter (e.g. ?key=&lt;key&gt;)</option>
            </select>
          </div>

          <div class="form-field" id="custom-header-container-${slotId}" style="${isCustom && slotCfg.authStyle === 'custom_header' ? '' : 'display: none;'}">
            <label class="form-label" for="custom-header-${slotId}">Custom Header Name</label>
            <input
              type="text"
              class="form-input"
              id="custom-header-${slotId}"
              value="${escapeHtml(slotCfg.customHeaderName ?? '')}"
              placeholder="e.g. X-API-Key, api-key"
            />
          </div>

          <div class="form-field" id="custom-query-container-${slotId}" style="${isCustom && slotCfg.authStyle === 'query_param' ? '' : 'display: none;'}">
            <label class="form-label" for="custom-query-${slotId}">Custom Query Parameter Name</label>
            <input
              type="text"
              class="form-input"
              id="custom-query-${slotId}"
              value="${escapeHtml(slotCfg.customQueryParamName ?? '')}"
              placeholder="e.g. key, api_key"
            />
          </div>

          <div class="form-field" id="custom-endpoint-container-${slotId}" style="${isCustom ? '' : 'display: none;'}">
            <label class="form-label" for="endpoint-path-${slotId}">Endpoint Path Override (Optional)</label>
            <input
              type="text"
              class="form-input"
              id="endpoint-path-${slotId}"
              value="${escapeHtml(slotCfg.endpointPathOverride ?? '')}"
              placeholder="e.g. /v1/chat/completions or /api/v1/generate"
            />
          </div></div>
          </details>
          ${isCustom ? `<p class="card-subtitle custom-model-free-text-note">Custom API model names are free text. You are not limited to the suggestions above; enter the exact model ID accepted by your API gateway. The endpoint must implement this feature's required request format.</p>` : ''}
          ${slotId === 'voice_tts' ? `<p class="card-subtitle">This slot requires a Text-to-Speech endpoint (text → audio), normally <code>/audio/speech</code> for OpenAI-compatible APIs. A chat/completions model alone is not sufficient.</p><p class="card-subtitle">If you change the TTS provider, model, voice, or API settings, audio that has already been preloaded may still use the previous settings. Your changes will apply to audio generated or preloaded next.</p>` : ''}
        </div>

        <section class="secondary-api-settings" aria-labelledby="secondary-api-heading-${slotId}">
          <div class="secondary-api-summary">
            <span class="settings-api-section-heading secondary-api-heading" id="secondary-api-heading-${slotId}"><span>API 2</span><small>Backup / rotation</small></span>
            <label class="secondary-api-switch-label" for="secondary-api-enabled-${slotId}">
              <span>Enable API 2</span>
              <input type="checkbox" class="secondary-api-switch" id="secondary-api-enabled-${slotId}" ${slotCfg.secondary ? 'checked' : ''} aria-controls="secondary-api-content-${slotId}" />
            </label>
          </div>
          <div class="secondary-api-content" id="secondary-api-content-${slotId}" ${slotCfg.secondary ? '' : 'hidden'}>
          <p class="card-subtitle secondary-api-help">Configure another provider/account and key. Speech recognition may rotate between verified APIs. API 2 is not guaranteed to be a different model or service: if you use the same gateway, model, or endpoint in both accounts, you may have no independent fallback. Check that each account supports the required operation (TTS: text → audio; STT: audio → text).</p>
          ${secondarySameModelAsPrimary ? `<div class="status-box info" role="note"><strong>API 2 uses the same provider and model as API 1.</strong> It may still have a separate key or quota, but it is not a different model or an independent model capability.</div>` : ''}
          <div class="form-grid">
            <div class="form-field"><label class="form-label" for="secondary-provider-${slotId}">Provider</label>
              <select class="form-select provider-native-select" id="secondary-provider-${slotId}" aria-hidden="true" tabindex="-1">
                <option value="">Not configured</option>
                ${def.providers.filter((p) => p.tier !== 3).map((p) => `<option value="${escapeHtml(p.id)}" ${slotCfg.secondary?.providerId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
              </select>
              <div class="provider-picker secondary-provider-picker" id="secondary-provider-picker-${slotId}">
                <button type="button" class="provider-picker-trigger" id="secondary-provider-trigger-${slotId}" aria-expanded="false"><span>${escapeHtml(secondaryPreset?.name ?? 'Not configured')}</span><span class="provider-picker-chevron">⌄</span></button>
                <div class="provider-picker-options" id="secondary-provider-options-${slotId}" hidden>
                  <button type="button" class="provider-picker-option ${slotCfg.secondary?.providerId ? '' : 'active'}" data-secondary-provider-id="">Not configured</button>
                  ${def.providers.filter((p) => p.tier !== 3).map((p) => `<button type="button" class="provider-picker-option ${slotCfg.secondary?.providerId === p.id ? 'active' : ''}" data-secondary-provider-id="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button>`).join('')}
                </div>
              </div>
            </div>

            <div class="form-field settings-baseurl-field"><label class="form-label" for="secondary-baseurl-${slotId}">Base URL</label>
              <input type="url" class="form-input settings-baseurl-input" id="secondary-baseurl-${slotId}" value="${escapeHtml(slotCfg.secondary?.baseUrl || secondaryPreset?.defaultBaseUrl || '')}" placeholder="${escapeHtml(secondaryPreset?.baseUrlPlaceholder ?? 'https://api.example.com/v1')}" ${secondaryPreset?.tier === 3 ? 'disabled' : ''} />
              <div class="status-box fail settings-mismatch-warning" id="secondary-mismatch-warning-${slotId}" style="${secondaryMismatchInfo.mismatch ? '' : 'display:none;'}">
                <div id="secondary-mismatch-warning-text-${slotId}" class="settings-mismatch-copy">${escapeHtml(secondaryMismatchInfo.reason ?? '')}</div>
                <button type="button" class="btn btn-secondary settings-switch-custom-btn" id="secondary-switch-custom-btn-${slotId}">Switch to Custom (OpenAI-compatible)</button>
              </div></div>
            <div class="form-field"><label class="form-label" for="secondary-key-${slotId}">API Key (${secondaryPreset?.requiresKey === false ? 'Offline — no key needed' : keyStorageLabel})</label>
              <input type="password" class="form-input" id="secondary-key-${slotId}" value="" autocomplete="off" placeholder="${secondaryPreset?.requiresKey === false ? 'No API key needed' : secondaryKeysBySlot[slotId] ? 'API 2 key is stored securely. Leave blank to keep it, or type a replacement.' : 'Enter second API key'}" ${secondaryPreset?.requiresKey === false ? 'disabled' : ''} /></div>
${secondaryPreset?.id === 'freetts_tts' ? '' : `            <div class="form-field">
              <div class="settings-field-heading">
                <label class="form-label" for="secondary-model-${slotId}">${escapeHtml(secondaryPreset?.modelFieldLabel ?? "Model / voice")}</label>
                <button type="button" class="btn btn-secondary settings-fetch-models-btn" id="fetch-secondary-models-btn-${slotId}">Fetch models</button>
              </div>
              <input type="text" class="form-input" id="secondary-model-${slotId}" value="${escapeHtml(slotCfg.secondary?.modelOrVoice ?? '')}" placeholder="${escapeHtml(secondaryPreset?.defaultModelOrVoice ?? 'Model name')}" />
              ${secondaryIsCustom ? `<p class="card-subtitle">Custom API 2 model ID is free text; suggestions do not limit what you can enter. Use the exact ID and audio endpoint supported by that gateway.</p>` : ''}
              <div class="model-picker-dropdown"><button type="button" class="model-picker-trigger" aria-expanded="false">Browse available models</button><div class="model-picker-options" id="secondary-models-list-${slotId}" hidden>${secondarySuggestions.map((model) => `<button type="button" class="model-option" data-model-value="${escapeHtml(model)}">${escapeHtml(model)}</button>`).join("")}</div></div><div id="fetch-secondary-models-msg-${slotId}" class="settings-fetch-models-message" role="status" aria-live="polite" hidden></div>
            </div>`}

            ${slotId === 'voice_tts' ? `<div class="form-field" id="secondary-tts-voice-container-${slotId}" style="${secondaryPreset && secondaryPreset.id !== 'android_native_tts' ? '' : 'display:none;'}">
              <label class="form-label" for="secondary-custom-voice-${slotId}">API 2 voice (choose from the available list or enter a custom name)</label>
              <input type="text" class="form-input" id="secondary-custom-voice-${slotId}" value="${escapeHtml(slotCfg.secondary?.customTtsVoice ?? '')}" placeholder="${secondaryPreset?.id === 'freetts_tts' ? 'en-US-JennyNeural' : secondaryPreset?.id === 'groq_tts' ? 'troy' : 'Choose or enter a voice name'}" autocomplete="off" />
              <div class="voice-picker-dropdown">
                <div class="btn-row">${secondaryPreset?.id === 'groq_tts' || secondaryPreset?.id === 'freetts_tts' ? '' : `<button type="button" class="btn btn-secondary settings-fetch-models-btn" id="fetch-secondary-voices-btn-${slotId}">Load available voices</button>`}<button type="button" class="btn btn-secondary" id="preview-secondary-voice-btn-${slotId}">Preview voice</button></div>
                <div class="model-picker-options" id="secondary-voices-list-${slotId}" hidden></div>
                <div id="preview-secondary-voice-msg-${slotId}" class="settings-fetch-models-message" role="status" aria-live="polite" hidden></div>
                <div id="fetch-secondary-voices-msg-${slotId}" class="settings-fetch-models-message" role="status" aria-live="polite" hidden></div>
              </div>
            </div>` : ''}

            ${secondaryCopyKeyOptionsHtml ? `
            <div class="form-field">
              <label class="form-label" for="secondary-copy-key-source-${slotId}">Or copy from</label>
              <div class="settings-copy-key">
                <select class="form-select provider-native-select" id="secondary-copy-key-source-${slotId}" aria-hidden="true" tabindex="-1">${secondaryCopyKeyOptionsHtml}</select>
                <div class="provider-picker copy-key-provider-picker" id="secondary-copy-key-picker-${slotId}">
                  <button type="button" class="provider-picker-trigger" id="secondary-copy-key-trigger-${slotId}" aria-expanded="false"><span>${escapeHtml(secondaryCopyKeySources[0]?.label ?? 'Choose source')}</span><span class="provider-picker-chevron">⌄</span></button>
                  <div class="provider-picker-options" id="secondary-copy-key-options-${slotId}" hidden>${secondaryCopyKeyPickerOptionsHtml}</div>
                </div>
                <button type="button" class="btn btn-secondary settings-copy-key-btn" id="secondary-copy-key-btn-${slotId}">Copy API key</button>
              </div>
              <p class="card-subtitle">You can copy an API 1 or API 2 key from another capability slot.</p>
            </div>` : ''}
            <details class="advanced-provider-settings" id="secondary-custom-auth-container-${slotId}" style="${secondaryIsCustom ? '' : 'display:none;'}">
              <summary>Advanced authentication & endpoint</summary>
              <div class="advanced-provider-fields">
            <div class="form-field"><label class="form-label" for="secondary-authstyle-${slotId}">Authentication</label>
              <select class="form-select" id="secondary-authstyle-${slotId}">
                <option value="bearer" ${(slotCfg.secondary?.authStyle ?? 'bearer') === 'bearer' ? 'selected' : ''}>Bearer</option>
                <option value="custom_header" ${slotCfg.secondary?.authStyle === 'custom_header' ? 'selected' : ''}>Custom header</option>
                <option value="query_param" ${slotCfg.secondary?.authStyle === 'query_param' ? 'selected' : ''}>Query parameter</option>
              </select></div>
            <div class="form-field" id="secondary-custom-header-container-${slotId}" style="${(slotCfg.secondary?.authStyle ?? 'bearer') === 'custom_header' ? '' : 'display:none;'}"><label class="form-label" for="secondary-custom-header-${slotId}">Custom header name</label>
              <input type="text" class="form-input" id="secondary-custom-header-${slotId}" value="${escapeHtml(slotCfg.secondary?.customHeaderName ?? '')}" placeholder="X-API-Key" /></div>
            <div class="form-field" id="secondary-custom-query-container-${slotId}" style="${slotCfg.secondary?.authStyle === 'query_param' ? '' : 'display:none;'}"><label class="form-label" for="secondary-custom-query-${slotId}">Custom query parameter</label>
              <input type="text" class="form-input" id="secondary-custom-query-${slotId}" value="${escapeHtml(slotCfg.secondary?.customQueryParamName ?? '')}" placeholder="api_key" /></div>
            <div class="form-field"><label class="form-label" for="secondary-endpoint-${slotId}">Endpoint path override (optional)</label>
              <input type="text" class="form-input" id="secondary-endpoint-${slotId}" value="${escapeHtml(slotCfg.secondary?.endpointPathOverride ?? '')}" placeholder="/v1/chat/completions" /></div>
            </div>
            </details>
          </div>
          </div>
        </section>

        <section class="settings-connection-tests" aria-label="Provider connection tests">
        <div class="btn-row provider-test-actions" >
          <button type="button" class="btn btn-primary settings-test-button" data-test-slot="${slotId}">Test API 1</button>
          <button type="button" class="btn btn-primary settings-test-button" id="test-secondary-${slotId}">Test API 2</button>
        </div>
        <p class="card-subtitle provider-save-help">Test each configured provider separately. The test saves its current settings and checks the connection.</p>
        <div class="provider-test-results" >
          <div class="card-subtitle">API 1 result:</div>
          ${statusHtml}
          ${verificationActionsHtml}
          ${secondaryStatusHtml}
        </div>
        </section>
        <div id="save-status-${slotId}" class="status-box info settings-save-status" hidden role="status" aria-live="polite"></div>
        <div class="btn-row provider-save-actions">
          <button type="button" class="btn btn-secondary settings-save-button" data-save-slot="${slotId}" >
            Save settings
          </button>
        </div>
        </div>
      </details>
    `;
  }).join('');

  const requiredCoreSlots: SlotId[] = ['llm_generator', 'llm_evaluator'];
  const isRequiredCoreSlotReady = (slotId: SlotId): boolean => {
    const config = configs[slotId];
    const savedTest = lastTestResults.get(slotId);
    const currentPrimaryTest = savedTest?.providerId === config.providerId ? savedTest : undefined;
    // A key being present is not proof that the capability works. Require a
    // successful online test for the active primary or verified API 2 account.
    return isOnlineProviderVerified(currentPrimaryTest, config.secondary);
  };
  const hasMissingRequiredApi = (): boolean =>
    requiredCoreSlots.some((slotId) => !isRequiredCoreSlotReady(slotId));

  container.innerHTML = `
    <section class="card settings-intro-card" aria-labelledby="ai-provider-settings-title">
      <div class="card-header">
        <h1 class="card-title" id="ai-provider-settings-title">AI provider settings</h1>
      </div>
      <p class="card-subtitle settings-provider-intro">
        An API connection is required for core AI features, including generating IELTS questions, evaluating answers, and creating new Shadowing sentences. Basic device-based speech tools may still work without an API, but connecting providers improves voice generation and speech-to-text quality and reliability. Requests are sent directly from your device.
      </p>
      ${recoveryNoticeHtml}
      ${apiKeyRecoveryNoticeHtml}
      ${browserKeyStorageNoticeHtml}
      <div class="quick-setup-disclosure">
        <button type="button" class="btn btn-secondary quick-setup-toggle" id="quick-setup-toggle" aria-expanded="false" aria-controls="quick-setup-panel">
          <span>Quick Setup</span><span class="quick-setup-toggle-icon" aria-hidden="true">＋</span>
        </button>
        <div class="quick-setup-panel" id="quick-setup-panel" hidden>
          <p class="card-subtitle">For the best experience, we recommend configuring the providers manually in API Settings below. If you use free API plans, separate accounts may help distribute legitimate usage where the provider's terms allow it.</p>
          <p class="card-subtitle">Quick Setup assigns Google Gemini as the default provider for most features and Groq as the backup. IELTS Evaluator uses Groq first with Gemini as backup. Voice/TTS can also use Groq Orpheus (WAV) when selected manually; Quick Setup keeps Gemini as the default. Both keys are optional if already stored; missing keys leave that provider unverified.</p>
          <ul class="quick-setup-links">
            <li><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Get a Google Gemini API key</a></li>
            <li><a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">Get a Groq API key</a></li>
          </ul>
          <div class="form-grid">
            <div class="form-field">
              <label class="form-label" for="quick-setup-gemini-key">Gemini API key</label>
              <input type="password" class="form-input" id="quick-setup-gemini-key" autocomplete="off" placeholder="Paste Gemini key (optional if already saved)" />
            </div>
            <div class="form-field">
              <label class="form-label" for="quick-setup-groq-key">Groq API key (optional)</label>
              <input type="password" class="form-input" id="quick-setup-groq-key" autocomplete="off" placeholder="Paste Groq key (optional)" />
            </div>
          </div>
          <p class="card-subtitle">Quick Setup fills API 1 and API 2 for all compatible features. API 2 is the fallback. Groq Orpheus is available as an optional Voice/TTS provider, but is not selected automatically. Connection checks run sequentially.</p>
          <div class="btn-row">
            <button type="button" class="btn btn-primary" id="quick-setup-run-btn">Set up recommended providers</button>
          </div>
          <ul class="quick-setup-checklist" id="quick-setup-checklist">
            ${SLOT_ORDER.map((slotId) => `<li data-quick-setup-slot="${slotId}"><span>${escapeHtml(SLOT_DEFINITIONS[slotId].title.replace(/^\d+\.\s*/, ''))}</span><span class="card-subtitle">Not checked</span></li>`).join('')}
          </ul>
          <div id="quick-setup-status" class="status-box info" role="status" aria-live="polite">Quick Setup fills both API slots automatically. It keeps API 2 as a fallback; Voice/TTS has no Groq-compatible backup. Connections are checked sequentially. Missing API keys leave those providers unverified.</div>
          <div class="quick-custom-provider">
            <label class="form-label"><input type="checkbox" id="quick-custom-enabled" /> Use custom URL and model</label>
            <div id="quick-custom-panel" hidden>
              <p class="card-subtitle">Enter a provider's base URL and API key, then fetch its model list or type a model ID manually. SpeakCoach will test each feature with its actual request format (TTS, STT, generation, evaluation and translation) before offering to apply the configuration. Tests may consume API quota.</p>
              <div class="form-grid">
                <div class="form-field"><label class="form-label" for="quick-custom-url">Provider base URL</label><input type="url" class="form-input" id="quick-custom-url" placeholder="https://api.example.com/v1" autocomplete="url" /></div>
                <div class="form-field"><label class="form-label" for="quick-custom-key">API key</label><input type="password" class="form-input" id="quick-custom-key" placeholder="Paste API key" autocomplete="off" /></div>
                <div class="form-field"><label class="form-label" for="quick-custom-model">Model ID</label><input type="text" class="form-input" id="quick-custom-model" placeholder="Enter or fetch a model ID" autocomplete="off" /></div>
              </div>
              <div class="btn-row">
                <button type="button" class="btn btn-secondary" id="quick-custom-fetch-models">Fetch models</button>
                <button type="button" class="btn btn-primary" id="quick-custom-test">Test capabilities</button>
                <button type="button" class="btn btn-secondary" id="quick-custom-apply" disabled>Apply to compatible slots</button>
              </div>
              <div id="quick-custom-models" class="model-picker-options" hidden></div>
              <div id="quick-custom-status" class="status-box info" role="status" aria-live="polite">No custom provider tested yet.</div>
              <ul id="quick-custom-results" class="quick-setup-checklist"></ul>
            </div>
          </div>
        </div>
      </div>
      <div class="settings-api-group-heading">
        <div class="settings-api-group-title">
          <h2 class="card-title">API Settings</h2>
          <span class="settings-api-required-label">Required</span>
        </div>
        <span id="required-api-status" class="settings-required-badge ${hasMissingRequiredApi() ? 'missing' : 'configured'}" role="status" aria-live="polite">${hasMissingRequiredApi() ? 'Core APIs need setup / test' : 'Core APIs configured'}</span>
      </div>
      <div class="settings-provider-cards">
        ${cardsHtml}
      </div>
    </section>
    <section class="card backup-card">
      <div class="card-header"><h2 class="card-title">Backup &amp; Restore</h2></div>
      <div class="backup-section">
        <h3 class="section-heading">AI provider settings</h3>
        
        <aside class="backup-security-warning" role="note" aria-label="Security warning"><strong class="backup-security-title">Security warning</strong><p><strong>Export AI settings</strong> includes your API keys. Anyone who gets that file could use those keys. Keep it private and store it securely. For sharing or cloud storage, use the no-key export instead.</p></aside>
        <div class="btn-row">
          <button type="button" class="btn btn-secondary" id="export-ai-backup">Export AI settings (with keys)</button>
          <button type="button" class="btn btn-secondary" id="export-ai-backup-no-keys">Export settings only (no keys)</button>
          <button type="button" class="btn btn-secondary" id="import-ai-backup">Import AI settings</button>
          ${hasConfiguredOnlineAccount ? '<button type="button" class="btn btn-secondary" id="test-all-apis-btn">Test all APIs</button>' : ''}
          <input type="file" id="import-ai-file" accept="application/json,.json" hidden />
        </div>
        <p class="card-subtitle">Tests run sequentially and may use a small amount of API quota. API 1 and API 2 are checked independently; a passing account remains available even if the alternate fails. Failed accounts keep their own re-test or cooldown status.</p>
        <div id="backup-status" class="status-box info" role="status" aria-live="polite">AI settings can be exported with API keys for device migration, or without keys for safer sharing. Importing a no-key backup leaves the API keys already stored on this device unchanged.</div>
      </div>
      <div class="backup-section">
        <h3 class="section-heading">Test data &amp; practice history</h3>
        
        <div class="btn-row">
          <button type="button" class="btn btn-secondary" id="export-test-backup">Export test data</button>
          <button type="button" class="btn btn-secondary" id="import-test-backup">Import test data</button>
          <input type="file" id="import-test-file" accept="application/json,.json" hidden />
        </div>
      </div>
      <div id="test-data-backup-status" class="status-box info" role="status" aria-live="polite" hidden></div>
    </section>
    <section class="card settings-language-card">
      <div class="card-header"><h2 class="card-title">Language / زبان</h2></div>
      <div class="appearance-setting">
        <div class="appearance-setting-copy">
          <label class="form-label" for="app-language">App language / زبان برنامه</label>
          <p class="card-subtitle">Choose English or فارسی. IELTS questions and final examiner feedback remain in English.</p>
        </div>
        <select class="form-select appearance-select" id="app-language">
          <option value="en" ${appSettings.language !== 'fa' ? 'selected' : ''}>English</option>
          <option value="fa" ${appSettings.language === 'fa' ? 'selected' : ''}>فارسی</option>
        </select>
        <div id="app-language-status" class="appearance-status" role="status" aria-live="polite">Language preference is saved on this device.</div>
      </div>
    </section>
    <section class="card settings-shadowing-performance-card">
      <div class="card-header"><h2 class="card-title">Shadowing performance</h2></div>
      <div class="appearance-setting">
        <div class="appearance-setting-copy">
          <label class="form-label" for="shadowing-prefetch-enabled">Prepare upcoming model audio in advance</label>
          <p class="card-subtitle">When enabled, SpeakCoach prepares up to four upcoming sentences in the background to reduce waiting. This uses your configured TTS provider's quota, even if you do not reach every sentence. Turn it off to avoid background TTS requests.</p>
        </div>
        <label class="form-label" for="shadowing-prefetch-enabled">
          <input type="checkbox" id="shadowing-prefetch-enabled" ${appSettings.prefetchShadowingAudio ? 'checked' : ''} />
          Enable audio prefetch
        </label>
        <div id="shadowing-prefetch-status" class="appearance-status" role="status" aria-live="polite">This preference is saved on this device.</div>
      </div>
    </section>
    <section class="card settings-appearance-card">
      <div class="card-header"><h2 class="card-title">Appearance</h2></div>
      <div class="appearance-setting">
        <div class="appearance-setting-copy">
          <label class="form-label" for="app-theme">Appearance</label>
          <p class="card-subtitle">Choose the look that feels comfortable. System follows your device setting.</p>
        </div>
        <select class="form-select appearance-select" id="app-theme" aria-describedby="app-theme-status">
          <option value="system" ${appSettings.theme === 'system' ? 'selected' : ''}>System</option>
          <option value="light" ${appSettings.theme === 'light' ? 'selected' : ''}>Light</option>
          <option value="dark" ${appSettings.theme === 'dark' ? 'selected' : ''}>Dark</option>
        </select>
        <div id="app-theme-status" class="appearance-status" role="status" aria-live="polite">Current appearance: ${appSettings.theme === 'system' ? 'System' : appSettings.theme === 'dark' ? 'Dark' : 'Light'}.</div>
      </div>
    </section>
    <section class="card settings-update-card" aria-labelledby="settings-update-title">
      <div class="card-header"><h2 class="card-title" id="settings-update-title">Software updates</h2></div>
      <p class="card-subtitle">Installed version: <strong>${escapeHtml(APP_VERSION)}</strong>. Check the official SpeakCoach GitHub releases for a newer version.</p>
      <div class="btn-row">
        <button type="button" class="btn btn-secondary" id="check-speakcoach-update">Check for updates</button>
      </div>
      <div id="speakcoach-update-status" class="status-box info" role="status" aria-live="polite">Updates are checked against the public SpeakCoach repository.</div>
      <div id="speakcoach-update-available" hidden>
        <p><strong id="speakcoach-update-version"></strong></p>
        <p class="card-subtitle" id="speakcoach-update-notes"></p>
        <div class="btn-row">
          <button type="button" class="btn btn-primary" id="download-speakcoach-update">Download update</button>
          <button type="button" class="btn btn-primary" id="install-speakcoach-update" hidden>Install downloaded update</button>
          <a class="btn btn-secondary" id="speakcoach-release-link" href="https://github.com/AriyanD/SpeakCoach/releases" target="_blank" rel="noopener noreferrer">View release</a>
        </div>
      </div>
    </section>
    <section class="card settings-about-card" aria-labelledby="settings-about-title">
      <div class="card-header"><h2 class="card-title" id="settings-about-title">About</h2></div>
      <p class="card-subtitle">SpeakCoach is a personal practice app for English shadowing and IELTS Speaking. It brings together speech practice, AI-assisted feedback and test history in one place.</p>
      <div class="settings-about-meta">
        <p><strong>Developed by</strong> AriyanD</p>
        <p><strong>Version</strong> ${escapeHtml(APP_VERSION)}</p>
        <p><a href="https://github.com/AriyanD" target="_blank" rel="noopener noreferrer">GitHub profile — github.com/AriyanD</a></p>
        <p><a href="https://github.com/AriyanD/SpeakCoach" target="_blank" rel="noopener noreferrer">Project repository</a></p>
      </div>
      <div class="btn-row"><button type="button" class="btn btn-secondary" id="settings-open-setup-guide">Open setup guide / راهنمای شروع</button></div>
      <p class="card-subtitle settings-about-disclaimer">AI-generated feedback is for learning and practice only. It is not an official IELTS score or a substitute for a certified examiner.</p>
    </section>
        <section class="card settings-diagnostics-card" aria-labelledby="settings-diagnostics-title">
      <div class="card-header">
        <div>
          <h2 class="card-title" id="settings-diagnostics-title">System Diagnostics</h2>
          <p class="card-subtitle">Connection checks, permissions and session logs</p>
        </div>
      </div>
      <p class="card-subtitle">Open the detailed diagnostics screen.</p>
      <div class="btn-row">
        <button type="button" class="btn btn-secondary" id="settings-open-diagnostics-btn">Open Diagnostics</button>
      </div>
    </section>`;



  const quickSetupToggle = container.querySelector<HTMLButtonElement>('#quick-setup-toggle');
  const quickSetupPanel = container.querySelector<HTMLElement>('#quick-setup-panel');
  quickSetupToggle?.addEventListener('click', () => {
    if (!quickSetupPanel) return;
    const opening = quickSetupPanel.hidden;
    quickSetupPanel.hidden = !opening;
    quickSetupToggle.setAttribute('aria-expanded', String(opening));
    const icon = quickSetupToggle.querySelector<HTMLElement>('.quick-setup-toggle-icon');
    if (icon) icon.textContent = opening ? '－' : '＋';
  });

  const refreshRequiredApiStatus = (): void => {
    const status = container.querySelector<HTMLElement>('#required-api-status');
    if (!status) return;
    const missing = hasMissingRequiredApi();
    status.className = `settings-required-badge ${missing ? 'missing' : 'configured'}`;
    status.textContent = missing ? 'Core API setup needed' : 'Core APIs configured';
  };

  const quickSetupButton = container.querySelector<HTMLButtonElement>('#quick-setup-run-btn');
  const quickSetupStatus = container.querySelector<HTMLElement>('#quick-setup-status');
  quickSetupButton?.addEventListener('click', async () => {
    const confirmed = await confirmInApp({
      title: 'Set up the recommended AI providers?',
      message: 'This configures API 1 and API 2 for the six features. API connection tests run sequentially and may consume quota. API 2 is configured as a fallback; Voice/TTS has no Groq-compatible TTS backup.',
      confirmLabel: 'Run quick setup',
      cancelLabel: 'Keep current settings',
      tone: 'danger'
    });
    if (!confirmed || !quickSetupButton) return;

    const geminiInput = container.querySelector<HTMLInputElement>('#quick-setup-gemini-key');
    const groqInput = container.querySelector<HTMLInputElement>('#quick-setup-groq-key');
    const suppliedKeys = {
      gemini: geminiInput?.value.trim() ?? '',
      groq: groqInput?.value.trim() ?? ''
    };
    type QuickProvider = { providerId: string; source: 'gemini' | 'groq'; baseUrl?: string; model?: string };
    type QuickPlanItem = { slotId: SlotId; primary: QuickProvider; secondary?: QuickProvider };
    const groqBaseUrl = 'https://api.groq.com/openai/v1';
    const groqLlmModel = 'openai/gpt-oss-120b';
    const plan: QuickPlanItem[] = [
      { slotId: 'voice_tts', primary: { providerId: 'gemini_tts', source: 'gemini' } },
      { slotId: 'pronunciation_scoring', primary: { providerId: 'gemini_pronunciation', source: 'gemini' }, secondary: { providerId: 'whisper_alignment', source: 'groq' } },
      { slotId: 'ielts_stt', primary: { providerId: 'gemini_stt', source: 'gemini' }, secondary: { providerId: 'whisper_stt', source: 'groq' } },
      { slotId: 'llm_evaluator', primary: { providerId: 'custom_openai_eval', source: 'groq', baseUrl: groqBaseUrl, model: groqLlmModel }, secondary: { providerId: 'gemini_eval', source: 'gemini' } },
      { slotId: 'llm_generator', primary: { providerId: 'gemini_gen', source: 'gemini' }, secondary: { providerId: 'custom_openai_gen', source: 'groq', baseUrl: groqBaseUrl, model: groqLlmModel } },
      { slotId: 'llm_translation', primary: { providerId: 'gemini_translation', source: 'gemini' }, secondary: { providerId: 'custom_openai_translation', source: 'groq', baseUrl: groqBaseUrl, model: groqLlmModel } }
    ];

    quickSetupButton.disabled = true;
    settingsProviderTestRunning = true;
    const batchButton = container.querySelector<HTMLButtonElement>('#test-all-apis-btn');
    if (batchButton) batchButton.disabled = true;
    quickSetupButton.textContent = 'Setting up…';
    if (quickSetupStatus) {
      quickSetupStatus.className = 'status-box info';
      quickSetupStatus.textContent = 'Configuring providers and checking available API keys one by one…';
    }
    let attempted = 0;
    let passed = 0;
    let skipped = 0;

    const resolveKey = async (slotId: SlotId, provider: QuickProvider, account: 'primary' | 'secondary'): Promise<string> => {
      const supplied = suppliedKeys[provider.source];
      if (supplied) return supplied;
      try {
        const localKey = await loadApiKeyStrict(slotId, provider.providerId, account);
        if (localKey.trim()) return localKey;
      } catch { /* Try another saved key from the same provider family. */ }

      const reusableProviderIds: Record<'gemini' | 'groq', string[]> = {
        gemini: ['gemini_tts', 'gemini_pronunciation', 'gemini_stt', 'gemini_eval', 'gemini_gen', 'gemini_translation'],
        groq: ['whisper_alignment', 'whisper_stt', 'custom_openai_eval', 'custom_openai_gen', 'custom_openai_translation']
      };
      for (const otherSlotId of SLOT_ORDER) {
        for (const providerId of reusableProviderIds[provider.source]) {
          if (!SLOT_DEFINITIONS[otherSlotId].providers.some((preset) => preset.id === providerId)) continue;
          for (const keyAccount of ['primary', 'secondary'] as const) {
            try {
              const savedKey = await loadApiKeyStrict(otherSlotId, providerId, keyAccount);
              if (savedKey.trim()) return savedKey;
            } catch { /* Continue scanning for a recoverable credential. */ }
          }
        }
      }
      return '';
    };

    const makeConfig = (slotId: SlotId, provider: QuickProvider, account: 'primary' | 'secondary', previous?: SlotConfig['secondary'] | SlotConfig): SlotConfig => {
      const preset = getPreset(slotId, provider.providerId);
      const sameProvider = previous?.providerId === provider.providerId;
      const config: SlotConfig = {
        slotId,
        providerId: provider.providerId,
        baseUrl: provider.baseUrl ?? (sameProvider ? previous!.baseUrl : preset.defaultBaseUrl),
        modelOrVoice: provider.model ?? (sameProvider ? previous!.modelOrVoice : preset.defaultModelOrVoice),
        authStyle: sameProvider ? previous!.authStyle : 'bearer',
        customHeaderName: sameProvider ? previous!.customHeaderName : undefined,
        customQueryParamName: sameProvider ? previous!.customQueryParamName : undefined,
        endpointPathOverride: sameProvider ? previous!.endpointPathOverride : undefined,
        customTtsVoice: sameProvider ? previous!.customTtsVoice : undefined,
        speechRate: slotId === 'voice_tts' ? configs[slotId].speechRate : undefined
      };
      if (account === 'secondary') {
        const priorSecondary = previous as SlotConfig['secondary'];
        config.authStyle = priorSecondary?.authStyle ?? 'bearer';
      }
      return config;
    };

    try {
      for (const item of plan) {
        const row = container.querySelector<HTMLElement>(`[data-quick-setup-slot="${item.slotId}"]`);
        const rowStatus = row?.querySelector<HTMLElement>('span:last-child');
        if (rowStatus) rowStatus.textContent = 'Configuring…';
        try {
          const previous = configs[item.slotId];
          const primaryPreset = getPreset(item.slotId, item.primary.providerId);
          const primaryKey = await resolveKey(item.slotId, item.primary, 'primary');
          const primaryConfig = makeConfig(item.slotId, item.primary, 'primary', previous);
          // Quick Setup may not recommend API 2 for this slot (Voice/TTS). Preserve the existing fallback.
          primaryConfig.secondary = previous.secondary;
          if (primaryKey) await saveApiKey(item.slotId, primaryPreset.id, primaryKey, 'primary');
          await saveSlotConfig(primaryConfig);
          clearPreloadedSentenceAudio();
          if (item.slotId === 'voice_tts') {
            await clearActiveShadowingAudioStore();
            clearGeminiLanguageFailures('gemini_tts');
          }
          configs[item.slotId] = primaryConfig;
          lastTestResults.delete(item.slotId);
          await clearSlotConnectionTestResult(item.slotId);

          let primaryStatus = 'Primary configured';
          if (primaryKey) {
            try {
              const result = await testAndPersistSlotAccount(primaryConfig, { apiKeyOverride: primaryKey, account: 'primary' });
              const persisted = await loadSlotConnectionTestResult(item.slotId);
              lastTestResults.set(item.slotId, persisted ?? result);
              attempted += 1;
              if (result.ok && result.tier !== 3) { passed += 1; primaryStatus = 'Primary verified'; }
              else primaryStatus = 'Primary test failed';
            } catch (error) {
              attempted += 1;
              await clearSlotConnectionTestResult(item.slotId);
              lastTestResults.delete(item.slotId);
              primaryStatus = `Primary test failed: ${error instanceof Error ? error.message : String(error)}`;
            }
          } else {
            skipped += 1;
            primaryStatus = 'Primary configured — key missing';
          }

          if (item.secondary) {
            const secondaryPreset = getPreset(item.slotId, item.secondary.providerId);
            const secondaryKey = await resolveKey(item.slotId, item.secondary, 'secondary');
            const secondaryConfigBase = makeConfig(item.slotId, item.secondary, 'secondary', previous.secondary);
            let secondaryConfig: NonNullable<SlotConfig['secondary']> = {
              providerId: secondaryConfigBase.providerId,
              baseUrl: secondaryConfigBase.baseUrl,
              modelOrVoice: secondaryConfigBase.modelOrVoice,
              authStyle: secondaryConfigBase.authStyle,
              customHeaderName: secondaryConfigBase.customHeaderName,
              customQueryParamName: secondaryConfigBase.customQueryParamName,
              endpointPathOverride: secondaryConfigBase.endpointPathOverride,
              customTtsVoice: secondaryConfigBase.customTtsVoice,
              verified: false
            };
            if (secondaryKey) await saveApiKey(item.slotId, secondaryPreset.id, secondaryKey, 'secondary');
            await saveSecondarySlotConfig(item.slotId, secondaryConfig);
            clearPreloadedSentenceAudio();
            if (item.slotId === 'voice_tts') {
                  await clearActiveShadowingAudioStore();
                  clearGeminiLanguageFailures('gemini_tts');
                }
            configs[item.slotId].secondary = secondaryConfig;

            let secondaryStatus = 'API 2 configured — key missing';
            if (secondaryKey) {
              try {
                const result = await testAndPersistSlotAccount({ ...secondaryConfigBase, secondary: undefined }, { apiKeyOverride: secondaryKey, account: 'secondary' });
                const testResult = { ok: result.ok && result.tier !== 3, latencyMs: result.latencyMs, message: result.message, testedAt: Date.now(), verificationFingerprint: result.verificationFingerprint };
                secondaryConfig = { ...secondaryConfig, verified: testResult.ok, testResult };
                clearPreloadedSentenceAudio();
                if (item.slotId === 'voice_tts') {
                  await clearActiveShadowingAudioStore();
                  clearGeminiLanguageFailures('gemini_tts');
                }
                configs[item.slotId].secondary = secondaryConfig;
                attempted += 1;
                if (testResult.ok) { passed += 1; secondaryStatus = 'API 2 verified'; }
                else secondaryStatus = 'API 2 test failed';
              } catch (error) {
                attempted += 1;
                const message = error instanceof Error ? error.message : String(error);
                const testResult = { ok: false, latencyMs: 0, message, testedAt: Date.now() };
                secondaryConfig = { ...secondaryConfig, verified: false, testResult };
                await saveSecondarySlotConfig(item.slotId, secondaryConfig);
                clearPreloadedSentenceAudio();
                if (item.slotId === 'voice_tts') {
                  await clearActiveShadowingAudioStore();
                  clearGeminiLanguageFailures('gemini_tts');
                }
                configs[item.slotId].secondary = secondaryConfig;
                secondaryStatus = `API 2 test failed: ${message}`;
              }
            } else skipped += 1;
            if (rowStatus) rowStatus.textContent = `${primaryStatus}; ${secondaryStatus}`;
          } else {
            if (rowStatus) rowStatus.textContent = `${primaryStatus}; no compatible Groq TTS backup`;
          }
        } catch (error) {
          skipped += 1;
          if (rowStatus) rowStatus.textContent = `Setup incomplete — ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      if (geminiInput) geminiInput.value = '';
      if (groqInput) groqInput.value = '';
      if (quickSetupStatus) {
        quickSetupStatus.className = attempted > 0 && passed === attempted ? 'status-box pass' : 'status-box info';
        quickSetupStatus.textContent = `Quick setup finished: ${passed} of ${attempted} API checks passed; ${skipped} provider(s) skipped or left unverified. Review any incomplete rows below.`;
      }
      refreshRequiredApiStatus();
      await _onSettingsUpdated();
    } finally {
      quickSetupButton.disabled = false;
      settingsProviderTestRunning = false;
      if (batchButton) batchButton.disabled = false;
      quickSetupButton.textContent = 'Set up recommended providers';
    }
  });

  const customProviderToggle = container.querySelector<HTMLInputElement>('#quick-custom-enabled');
  const customProviderPanel = container.querySelector<HTMLElement>('#quick-custom-panel');
  const customProviderUrl = container.querySelector<HTMLInputElement>('#quick-custom-url');
  const customProviderKey = container.querySelector<HTMLInputElement>('#quick-custom-key');
  const customProviderModel = container.querySelector<HTMLInputElement>('#quick-custom-model');
  const customProviderModels = container.querySelector<HTMLElement>('#quick-custom-models');
  const customProviderStatus = container.querySelector<HTMLElement>('#quick-custom-status');
  const customProviderResults = container.querySelector<HTMLElement>('#quick-custom-results');
  const customProviderFetchButton = container.querySelector<HTMLButtonElement>('#quick-custom-fetch-models');
  const customProviderTestButton = container.querySelector<HTMLButtonElement>('#quick-custom-test');
  const customProviderApplyButton = container.querySelector<HTMLButtonElement>('#quick-custom-apply');
  const customTestResults = new Map<SlotId, { config: SlotConfig; result: ConnectionTestResult }>();

  customProviderToggle?.addEventListener('change', () => {
    if (customProviderPanel) customProviderPanel.hidden = !customProviderToggle.checked;
  });

  [customProviderUrl, customProviderKey, customProviderModel].forEach(field => {
    field?.addEventListener('input', () => {
      customTestResults.clear();
      if (customProviderApplyButton) customProviderApplyButton.disabled = true;
      if (customProviderStatus) {
        customProviderStatus.className = 'status-box info';
        customProviderStatus.textContent = 'Custom provider details changed. Run the capability test again before applying.';
      }
    });
  });

  customProviderFetchButton?.addEventListener('click', async () => {
    const baseUrl = customProviderUrl?.value.trim() ?? '';
    const apiKey = customProviderKey?.value.trim() ?? '';
    if (!baseUrl || !apiKey) {
      if (customProviderStatus) {
        customProviderStatus.className = 'status-box info';
        customProviderStatus.textContent = 'Enter the provider base URL and API key first.';
      }
      return;
    }
    customProviderFetchButton.disabled = true;
    if (customProviderStatus) customProviderStatus.textContent = 'Fetching available models…';
    try {
      const slotId: SlotId = 'llm_generator';
      const providerId = getCustomProviderIdForSlot(slotId);
      const preset = getPreset(slotId, providerId);
      const config: SlotConfig = { slotId, providerId, baseUrl, modelOrVoice: customProviderModel?.value.trim() || preset.defaultModelOrVoice, authStyle: 'bearer' };
      const response = await fetchAvailableModels(config, apiKey);
      if (customProviderStatus) {
        customProviderStatus.className = response.supported && response.models.length ? 'status-box pass' : 'status-box info';
        customProviderStatus.textContent = response.message;
      }
      if (customProviderModels && response.supported && response.models.length) {
        customProviderModels.innerHTML = response.models.map(model => `<button type="button" class="model-option" data-quick-custom-model="${escapeHtml(model)}">${escapeHtml(model)}</button>`).join('');
        customProviderModels.hidden = false;
      }
    } catch (error) {
      if (customProviderStatus) {
        customProviderStatus.className = 'status-box fail';
        customProviderStatus.textContent = error instanceof Error ? error.message : String(error);
      }
    } finally {
      customProviderFetchButton.disabled = false;
    }
  });

  customProviderModels?.addEventListener('click', event => {
    const option = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-quick-custom-model]');
    if (!option || !customProviderModel) return;
    customProviderModel.value = option.dataset.quickCustomModel ?? '';
    customProviderModels.hidden = true;
    customTestResults.clear();
    if (customProviderApplyButton) customProviderApplyButton.disabled = true;
  });

  customProviderTestButton?.addEventListener('click', async () => {
    const baseUrl = customProviderUrl?.value.trim() ?? '';
    const apiKey = customProviderKey?.value.trim() ?? '';
    const model = customProviderModel?.value.trim() ?? '';
    if (!baseUrl || !apiKey || !model) {
      if (customProviderStatus) {
        customProviderStatus.className = 'status-box info';
        customProviderStatus.textContent = 'Enter the provider URL, API key and model ID before testing.';
      }
      return;
    }
    customTestResults.clear();
    if (customProviderApplyButton) customProviderApplyButton.disabled = true;
    if (customProviderResults) customProviderResults.innerHTML = '';
    customProviderTestButton.disabled = true;
    settingsProviderTestRunning = true;
    const batchButton = container.querySelector<HTMLButtonElement>('#test-all-apis-btn');
    if (batchButton) batchButton.disabled = true;
    if (customProviderFetchButton) customProviderFetchButton.disabled = true;
    if (customProviderStatus) {
      customProviderStatus.className = 'status-box info';
      customProviderStatus.textContent = 'Testing six capabilities sequentially. Keep this screen open; some probes may take up to 45 seconds.';
    }
    for (const slotId of SLOT_ORDER) {
      const providerId = getCustomProviderIdForSlot(slotId);
      const preset = getPreset(slotId, providerId);
      const config: SlotConfig = {
        slotId,
        providerId,
        baseUrl,
        modelOrVoice: model,
        authStyle: 'bearer',
        customTtsVoice: undefined,
        speechRate: slotId === 'voice_tts' ? configs.voice_tts.speechRate : undefined
      };
      const row = document.createElement('li');
      row.innerHTML = `<span>${escapeHtml(SLOT_DEFINITIONS[slotId].title.replace(/^\d+\.\s*/, ''))}</span><span class="card-subtitle">Testing…</span>`;
      customProviderResults?.appendChild(row);
      try {
        const result = await testSlotConnection(config, { apiKeyOverride: apiKey, isOnlineOverride: true, recordRuntimeFailure: false });
        customTestResults.set(slotId, { config, result });
        const label = row.querySelector<HTMLElement>('span:last-child');
        if (label) label.textContent = result.message;
        row.classList.toggle('pass', result.ok && result.tier !== 3);
        row.classList.toggle('fail', !result.ok || result.tier === 3);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed: ConnectionTestResult = {
          ok: false,
          slotId,
          providerId,
          tier: preset.tier,
          label: 'Online AI',
          latencyMs: 0,
          message: `FAIL — ${message}`
        };
        customTestResults.set(slotId, { config, result: failed });
        const label = row.querySelector<HTMLElement>('span:last-child');
        if (label) label.textContent = failed.message;
        row.classList.add('fail');
      }
    }
    const compatible = Array.from(customTestResults.values()).filter(item => item.result.ok && item.result.tier !== 3).length;
    if (customProviderStatus) {
      customProviderStatus.className = compatible ? 'status-box pass' : 'status-box fail';
      customProviderStatus.textContent = `Capability test complete: ${compatible} of ${SLOT_ORDER.length} slots passed. Only passing slots can be applied.`;
    }
    if (customProviderApplyButton) customProviderApplyButton.disabled = compatible === 0;
    customProviderTestButton.disabled = false;
    settingsProviderTestRunning = false;
    if (batchButton) batchButton.disabled = false;
    if (customProviderFetchButton) customProviderFetchButton.disabled = false;
  });

  customProviderApplyButton?.addEventListener('click', async () => {
    const apiKey = customProviderKey?.value.trim() ?? '';
    const compatible = Array.from(customTestResults.entries()).filter(([, item]) => item.result.ok && item.result.tier !== 3);
    if (!apiKey || compatible.length === 0) return;
    const confirmed = await confirmInApp({
      title: 'Apply this custom provider?',
      message: `This replaces API 1 settings for ${compatible.length} compatible feature slot(s). Existing API 2 backups will be preserved. Continue?`,
      confirmLabel: 'Apply to compatible slots',
      cancelLabel: 'Keep current settings',
      tone: 'danger'
    });
    if (!confirmed) return;
    customProviderApplyButton.disabled = true;
    if (customProviderStatus) {
      customProviderStatus.className = 'status-box info';
      customProviderStatus.textContent = 'Saving tested provider settings…';
    }
    let applied = 0;
    for (const [slotId, item] of compatible) {
      try {
        const config: SlotConfig = { ...item.config, secondary: configs[slotId].secondary };
        await saveApiKey(slotId, config.providerId, apiKey, 'primary');
        await saveSlotConfig(config);
        clearPreloadedSentenceAudio();
        if (slotId === 'voice_tts') {
            await clearActiveShadowingAudioStore();
            clearGeminiLanguageFailures('gemini_tts');
          }
        configs[slotId] = config;
        const persisted = await saveSlotConnectionTestResult(slotId, item.result);
        lastTestResults.set(slotId, persisted);
        applied++;
      } catch (error) {
        console.error(`[SpeakCoach] Could not apply custom provider to ${slotId}.`, error);
      }
    }
    if (customProviderStatus) {
      customProviderStatus.className = applied === compatible.length ? 'status-box pass' : 'status-box info';
      customProviderStatus.textContent = `Applied to ${applied} of ${compatible.length} compatible slots. Existing API 2 backups were preserved.`;
    }
    customProviderApplyButton.disabled = applied === 0;
    if (applied > 0 && applied === compatible.length && customProviderKey) {
      customProviderKey.value = '';
    }
    refreshRequiredApiStatus();
    await _onSettingsUpdated();
  });

  const updateStatus = container.querySelector<HTMLElement>('#speakcoach-update-status');
  const checkUpdateButton = container.querySelector<HTMLButtonElement>('#check-speakcoach-update');
  const updateAvailablePanel = container.querySelector<HTMLElement>('#speakcoach-update-available');
  const updateVersionLabel = container.querySelector<HTMLElement>('#speakcoach-update-version');
  const updateNotesLabel = container.querySelector<HTMLElement>('#speakcoach-update-notes');
  const updateReleaseLink = container.querySelector<HTMLAnchorElement>('#speakcoach-release-link');
  const downloadUpdateButton = container.querySelector<HTMLButtonElement>('#download-speakcoach-update');
  const installUpdateButton = container.querySelector<HTMLButtonElement>('#install-speakcoach-update');
  let availableUpdate: SpeakCoachUpdate | null = null;
  let downloadedUpdatePath: string | null = null;

  const setUpdateStatus = (message: string, kind: 'info' | 'pass' | 'fail' = 'info'): void => {
    if (!updateStatus) return;
    updateStatus.className = `status-box ${kind}`;
    updateStatus.textContent = message;
  };

  checkUpdateButton?.addEventListener('click', async () => {
    if (Capacitor.getPlatform() !== 'android') {
      setUpdateStatus('In-app APK updates are available in the Android app.', 'info');
      return;
    }
    checkUpdateButton.disabled = true;
    if (downloadUpdateButton) downloadUpdateButton.disabled = false;
    if (installUpdateButton) installUpdateButton.hidden = true;
    if (updateAvailablePanel) updateAvailablePanel.hidden = true;
    downloadedUpdatePath = null;
    availableUpdate = null;
    setUpdateStatus('Checking the latest published SpeakCoach release…');
    try {
      const update = await checkForSpeakCoachUpdate();
      if (!update) {
        setUpdateStatus('You are using the latest published version of SpeakCoach.', 'pass');
        return;
      }
      availableUpdate = update;
      if (updateVersionLabel) updateVersionLabel.textContent = `Version ${update.version} is available`;
      if (updateNotesLabel) updateNotesLabel.textContent = update.releaseNotes || 'No release notes were provided.';
      if (updateReleaseLink) updateReleaseLink.href = update.releaseUrl;
      if (updateAvailablePanel) updateAvailablePanel.hidden = false;
      setUpdateStatus('A newer version is available. Download it when you are ready.', 'pass');
    } catch (error) {
      setUpdateStatus(error instanceof Error ? error.message : String(error), 'fail');
    } finally {
      checkUpdateButton.disabled = false;
    }
  });

  downloadUpdateButton?.addEventListener('click', async () => {
    if (!availableUpdate) return;
    downloadUpdateButton.disabled = true;
    setUpdateStatus(`Downloading SpeakCoach ${availableUpdate.version}…`);
    try {
      downloadedUpdatePath = await downloadSpeakCoachUpdate(availableUpdate.asset);
      if (installUpdateButton) installUpdateButton.hidden = false;
      setUpdateStatus('The update APK has been downloaded. Tap Install downloaded update to continue.', 'pass');
    } catch (error) {
      setUpdateStatus(error instanceof Error ? error.message : String(error), 'fail');
    } finally {
      downloadUpdateButton.disabled = false;
    }
  });

  installUpdateButton?.addEventListener('click', async () => {
    const updatePath = downloadedUpdatePath;
    const update = availableUpdate;
    if (!updatePath || !update) return;
    installUpdateButton.disabled = true;
    try {
      const permissionRequired = await installSpeakCoachUpdate(updatePath, update.asset.sha256);
      setUpdateStatus(
        permissionRequired
          ? 'Android opened the install-permission screen. Allow SpeakCoach to install apps, return here, then tap Install downloaded update again.'
          : 'Android package installer opened. Follow the system prompts to install the update.',
        'info'
      );
    } catch (error) {
      setUpdateStatus(error instanceof Error ? error.message : String(error), 'fail');
    } finally {
      installUpdateButton.disabled = false;
    }
  });

  container.querySelector<HTMLButtonElement>('#settings-open-diagnostics-btn')?.addEventListener('click', () => {
    onOpenDiagnostics?.();
  });

  const languageSelect = container.querySelector<HTMLSelectElement>('#app-language');
  languageSelect?.addEventListener('change', async () => {
    const language = languageSelect.value === 'fa' ? 'fa' : 'en';
    languageSelect.disabled = true;
    try {
      await saveAppSettings({ language });
      applyAppLanguage(language);
      applyLanguageToDocument(language);
      const status = container.querySelector<HTMLElement>('#app-language-status');
      if (status) status.textContent = language === 'fa' ? 'زبان فارسی انتخاب شد. محتوای آموزشی و بازخورد نهایی آزمون انگلیسی باقی می‌ماند.' : 'English selected. Learning content and final test feedback remain in English.';
      if (language === 'en') await _onSettingsUpdated();
    } catch {
      languageSelect.value = appSettings.language === 'fa' ? 'fa' : 'en';
      const status = container.querySelector<HTMLElement>('#app-language-status');
      if (status) status.textContent = 'Could not save the language setting. Please try again.';
    } finally { languageSelect.disabled = false; }
  });
  const shadowingPrefetchToggle = container.querySelector<HTMLInputElement>('#shadowing-prefetch-enabled');
  shadowingPrefetchToggle?.addEventListener('change', async () => {
    const enabled = shadowingPrefetchToggle.checked;
    shadowingPrefetchToggle.disabled = true;
    const status = container.querySelector<HTMLElement>('#shadowing-prefetch-status');
    try {
      await saveAppSettings({ prefetchShadowingAudio: enabled });
      appSettings.prefetchShadowingAudio = enabled;
      if (status) status.textContent = enabled
        ? 'Audio prefetch is enabled. Upcoming sentences may use your TTS provider quota.'
        : 'Audio prefetch is disabled. Model audio will be requested when you play each sentence.';
    } catch {
      shadowingPrefetchToggle.checked = appSettings.prefetchShadowingAudio;
      if (status) status.textContent = 'Could not save this preference. Please try again.';
    } finally {
      shadowingPrefetchToggle.disabled = false;
    }
  });

  container.querySelector<HTMLButtonElement>('#settings-open-setup-guide')?.addEventListener('click', () => { void showSetupGuide(); });

  const themeSelect = container.querySelector<HTMLSelectElement>('#app-theme');
  const themeStatus = container.querySelector<HTMLElement>('#app-theme-status');
  themeSelect?.addEventListener('change', async () => {
    if (!themeSelect) return;
    const previousValue = appSettings.theme;
    const requestedTheme = themeSelect.value;
    if (requestedTheme !== 'system' && requestedTheme !== 'light' && requestedTheme !== 'dark') return;
    themeSelect.disabled = true;
    try {
      await setThemePreference(requestedTheme);
      appSettings.theme = requestedTheme;
      if (themeStatus) themeStatus.textContent = requestedTheme === 'system'
        ? 'Appearance follows your device setting.'
        : `Appearance set to ${requestedTheme === 'dark' ? 'Dark' : 'Light'}.`;
    } catch {
      themeSelect.value = previousValue;
      if (themeStatus) themeStatus.textContent = 'Could not save the appearance setting. Please try again.';
    } finally {
      themeSelect.disabled = false;
    }
  });

  const backupStatus = container.querySelector<HTMLElement>('#backup-status');
  const testDataBackupStatus = container.querySelector<HTMLElement>('#test-data-backup-status');
  let testAllApisButton: HTMLButtonElement | null = null;
  const persistSlotDrafts: Partial<Record<SlotId, () => Promise<void>>> = {};

  const restoreSelectedBackup = async (
    kind: BackupKind,
    readPayload: () => Promise<unknown>
  ): Promise<void> => {
    const warning = kind === 'ai-settings'
      ? 'Import AI provider settings AND API keys? This will replace the current provider settings and keys with the values in the backup. Only import a file you trust. All providers must pass test again.'
      : 'Import test data? Existing IELTS history, generated question sets, undo history and practice tracking data will be replaced by the backup.';
    const confirmed = await confirmInApp({
      title: kind === 'ai-settings' ? 'Replace AI settings and keys?' : 'Replace practice data?',
      message: warning,
      confirmLabel: 'Import backup',
      cancelLabel: 'Cancel',
      tone: 'danger'
    });
    if (!confirmed) return;

    const importButton = container.querySelector<HTMLButtonElement>(
      kind === 'ai-settings' ? '#import-ai-backup' : '#import-test-backup'
    );
    if (importButton) importButton.disabled = true;
    if (testAllApisButton) testAllApisButton.disabled = true;
    const operationStatus = kind === 'ai-settings' ? backupStatus : testDataBackupStatus;
    if (operationStatus) {
      operationStatus.hidden = false;
      operationStatus.className = 'status-box info';
      operationStatus.textContent = 'Reading and validating the selected backup…';
    }
    try {
      const payload = await readPayload();
      await restoreBackup(kind, payload);
      if (operationStatus) {
        operationStatus.hidden = false;
        operationStatus.className = 'status-box pass';
        operationStatus.textContent = kind === 'ai-settings'
          ? 'AI provider settings and API keys restored and verified in storage. Keep the backup file private. Run the test for each provider.'
          : 'Test history and practice data restored.';
      }
      await _onSettingsUpdated();
    } catch (error) {
      if (operationStatus) {
        operationStatus.hidden = false;
        operationStatus.className = 'status-box fail';
        operationStatus.textContent = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (importButton) importButton.disabled = false;
      if (testAllApisButton) testAllApisButton.disabled = settingsProviderTestRunning || !hasConfiguredOnlineAccount;
    }
  };

  const wireBackup = (kind: BackupKind): void => {
    const suffix = kind === 'ai-settings' ? 'ai' : 'test';
    const exportButton = container.querySelector<HTMLButtonElement>(`#export-${suffix}-backup`);
    const importButton = container.querySelector<HTMLButtonElement>(`#import-${suffix}-backup`);
    const fileInput = container.querySelector<HTMLInputElement>(`#import-${suffix}-file`);
    const operationStatus = kind === 'ai-settings' ? backupStatus : testDataBackupStatus;
    exportButton?.addEventListener('click', async () => {
      if (exportButton) exportButton.disabled = true;
      try {
        if (operationStatus) operationStatus.hidden = false;
        if (kind === 'ai-settings') {
          if (operationStatus) {
            operationStatus.className = 'status-box info';
            operationStatus.textContent = 'Saving the current provider settings and API keys before export...';
          }
          // Capture the values currently shown in every provider form so recently
          // entered API keys are not silently omitted from the backup.
          for (const slotId of SLOT_ORDER) {
            await persistSlotDrafts[slotId]?.();
          }
        }
        const payload = await createBackup(kind);
        await downloadBackupFile(kind, payload);
        if (operationStatus) {
          if (kind === 'ai-settings') {
            const backupConfigs = payload.configs as AllSlotsConfig;
            const backupKeys = payload.apiKeys as Record<string, { primary?: string; secondary?: string }> | undefined;
            const requiredKeyAccounts: Array<{ slotId: SlotId; account: 'primary' | 'secondary'; label: string }> = [];
            for (const slotId of SLOT_ORDER) {
              const config = backupConfigs[slotId];
              if (getPreset(slotId, config.providerId).requiresKey) {
                requiredKeyAccounts.push({ slotId, account: 'primary', label: `${SLOT_DEFINITIONS[slotId].title} (API 1)` });
              }
              if (config.secondary && getPreset(slotId, config.secondary.providerId).requiresKey) {
                requiredKeyAccounts.push({ slotId, account: 'secondary', label: `${SLOT_DEFINITIONS[slotId].title} (API 2)` });
              }
            }
            const missingKeyAccounts = requiredKeyAccounts.filter(({ slotId, account }) =>
              !(backupKeys?.[slotId]?.[account] ?? '').trim()
            );
            const includedCount = requiredKeyAccounts.length - missingKeyAccounts.length;
            operationStatus.className = missingKeyAccounts.length ? 'status-box info' : 'status-box pass';
            operationStatus.textContent = missingKeyAccounts.length
              ? `AI settings backup created. Saved API keys included for ${includedCount}/${requiredKeyAccounts.length} configured provider accounts. No saved key was found for: ${missingKeyAccounts.map(item => item.label).join(', ')}. Keep this file private and secure.`
              : `AI settings backup created. Saved API keys included for all ${includedCount} configured provider accounts. Keep this file private and secure.`;
          } else {
            operationStatus.className = 'status-box pass';
            operationStatus.textContent = 'Test data backup created.';
          }
        }
      } catch (error) {
        if (operationStatus) {
          operationStatus.className = 'status-box fail';
          operationStatus.textContent = error instanceof Error ? error.message : String(error);
        }
      } finally { if (exportButton) exportButton.disabled = false; }
    });
    importButton?.addEventListener('click', () => {
      if (isNativeBackupImportAvailable()) {
        void restoreSelectedBackup(kind, async () => {
          const selected = await selectNativeBackupFile();
          return parseBackupJsonText(selected.contents);
        });
        return;
      }
      fileInput?.click();
    });
    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      await restoreSelectedBackup(kind, () => readBackupFile(file));
      fileInput.value = '';
    });
  };
  wireBackup('ai-settings');
  wireBackup('test-data');

  const testAllButton = container.querySelector<HTMLButtonElement>('#test-all-apis-btn');
  testAllApisButton = testAllButton;
  let testAllApisRunning = false;
  let cancelTestAllApis = false;
  testAllButton?.addEventListener('click', async () => {
    if (!testAllButton) return;
    if (testAllApisRunning) { cancelTestAllApis = true; testAllButton.textContent = 'Cancelling…'; return; }
    if (settingsProviderTestRunning) return;
    if (!backupStatus) return;
    if (!networkMonitor.isOnline()) {
      backupStatus.className = 'status-box fail';
      backupStatus.textContent = 'No connection — nothing tested. No verification state was changed.';
      return;
    }
    const confirmed = await confirmInApp({
      title: 'Test all configured APIs?',
      message: 'Connection probes send real requests and may use a small amount of API quota. Tests run sequentially. API 1 and API 2 are verified independently: a passing account remains available even if its alternate fails, while the failed account receives its own re-test or cooldown state.',
      confirmLabel: 'Test all APIs',
      cancelLabel: 'Cancel',
      tone: 'normal'
    });
    if (!confirmed) return;

    testAllApisRunning = true;
    settingsProviderTestRunning = true;
    cancelTestAllApis = false;
    testAllButton.textContent = 'Cancel tests';
    const singleTestButtons = [
      ...Array.from(container.querySelectorAll<HTMLButtonElement>('.settings-test-button')),
      container.querySelector<HTMLButtonElement>('#quick-setup-run-btn'),
      container.querySelector<HTMLButtonElement>('#quick-custom-test')
    ].filter((button): button is HTMLButtonElement => !!button);
    const importButtons = ['#import-ai-backup', '#import-test-backup'].map(selector => container.querySelector<HTMLButtonElement>(selector)).filter((button): button is HTMLButtonElement => !!button);
    const previousDisabled = [...singleTestButtons, ...importButtons].map(button => button.disabled);
    [...singleTestButtons, ...importButtons].forEach(button => { button.disabled = true; });
    if (testAllApisButton) testAllButton.disabled = false;
    const reports: string[] = [];
    const redactKeys = (message: string): string => {
      let safe = message;
      for (const secret of [...Object.values(keysBySlot), ...Object.values(secondaryKeysBySlot)].filter(Boolean)) {
        safe = safe.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]');
      }
      return safe;
    };
    let savedSlots = 0;
    let notSavedSlots = 0;
    let skippedSlots = 0;
    let completedAccounts = 0;
    const plannedAccounts = SLOT_ORDER.reduce((total, slotId) => {
      const primary = getPreset(slotId, configs[slotId].providerId);
      const secondary = configs[slotId].secondary ? getPreset(slotId, configs[slotId].secondary!.providerId) : null;
      return total + Number(primary.tier !== 3 && (!primary.requiresKey || !!keysBySlot[slotId].trim())) +
        Number(Boolean(secondary && secondary.tier !== 3 && (!secondary.requiresKey || !!secondaryKeysBySlot[slotId].trim())));
    }, 0);

    try {
      backupStatus.className = 'status-box info';
      backupStatus.textContent = 'Preparing sequential connection tests…';
      for (const slotId of SLOT_ORDER) {
        if (cancelTestAllApis) break;
        if (completedAccounts > 0) await new Promise(resolve => window.setTimeout(resolve, 350));
        if (cancelTestAllApis) break;
        const slotTitle = SLOT_DEFINITIONS[slotId].title.replace(/^\\d+\\.\\s*/, '');
        const accounts: Array<{ account: 'primary' | 'secondary'; config: SlotConfig; key: string; providerName: string }> = [];
        const skippedAccounts: string[] = [];
        const primaryConfig = configs[slotId];
        const primaryPreset = getPreset(slotId, primaryConfig.providerId);
        if (primaryPreset.tier === 3) skippedAccounts.push(`API 1 (${primaryPreset.name}) skipped — offline provider`);
        else if (primaryPreset.requiresKey && !keysBySlot[slotId].trim()) skippedAccounts.push(`API 1 (${primaryPreset.name}) skipped — API key missing`);
        else accounts.push({ account: 'primary', config: primaryConfig, key: keysBySlot[slotId], providerName: primaryPreset.name });
        const secondarySaved = configs[slotId].secondary;
        if (secondarySaved) {
          const secondaryPreset = getPreset(slotId, secondarySaved.providerId);
          if (secondaryPreset.tier === 3) skippedAccounts.push(`API 2 (${secondaryPreset.name}) skipped — offline provider`);
          else if (secondaryPreset.requiresKey && !secondaryKeysBySlot[slotId].trim()) skippedAccounts.push(`API 2 (${secondaryPreset.name}) skipped — API key missing`);
          else accounts.push({ account: 'secondary', config: { slotId, ...secondarySaved }, key: secondaryKeysBySlot[slotId], providerName: secondaryPreset.name });
        } else skippedAccounts.push('API 2 skipped — not configured');
        if (!accounts.length) {
          skippedSlots += 1;
          for (const account of ['primary', 'secondary'] as const) {
            const statusBox = container.querySelector<HTMLElement>(account === 'primary' ? `#status-${slotId}` : `#secondary-status-${slotId}`);
            if (statusBox) {
              statusBox.style.display = '';
              statusBox.className = 'status-box info';
              statusBox.textContent = `${account === 'primary' ? 'API 1' : 'API 2'}: ${skippedAccounts.find(reason => reason.startsWith(account === 'primary' ? 'API 1' : 'API 2')) || 'Skipped — not configured'}`;
            }
          }
          reports.push(`<li><strong>${escapeHtml(slotTitle)}</strong>: ${skippedAccounts.join(' · ')} — <strong>Skipped</strong>; no verification state changed.</li>`);
          continue;
        }

        const batch = await testSlotAccountsSequentially(
          accounts.map(item => ({ account: item.account, config: item.config, apiKeyOverride: item.key })),
          {
            pauseMs: 350,
            shouldCancel: () => cancelTestAllApis,
            onProgress: (_current, _total, item) => {
              completedAccounts += 1;
              backupStatus.textContent = `Testing ${completedAccounts} of ${Math.max(plannedAccounts, completedAccounts)}: ${slotTitle} — ${item.account === 'primary' ? 'API 1' : 'API 2'} (${getPreset(slotId, item.config.providerId).name})…`;
            }
          }
        );
        const tested = batch.results;
        if (batch.cancelled || cancelTestAllApis) {
          reports.push(`<li><strong>${escapeHtml(slotTitle)}</strong>: Cancelled before all configured accounts finished; previous verification preserved.</li>`);
          break;
        }
        const failed = tested.filter(item => !item.result.ok || item.result.tier === 3);
        if (shouldPersistSlotVerification(tested, accounts.length)) {
          const previousPrimary = await loadSlotConnectionTestResult(slotId);
          const previousSecondary = configs[slotId].secondary;
          const previousLastTest = lastTestResults.get(slotId);
          try {
            for (const item of tested) {
              const accountPassed = item.result.ok && item.result.tier !== 3;
              const persistedResult = await persistSlotAccountTestResult(item.config, item.result, item.account);
              if (item.account === 'primary' && persistedResult) {
                lastTestResults.set(slotId, persistedResult);
              } else if (item.account === 'secondary') {
                configs[slotId].secondary = { ...item.config, verified: accountPassed, testResult: {
                  ok: accountPassed, latencyMs: item.result.latencyMs, message: item.result.message,
                  testedAt: Date.now(), verificationFingerprint: item.result.verificationFingerprint
                } };
              }
            }
            savedSlots += 1;
            const usable = tested.filter(item => item.result.ok && item.result.tier !== 3);
            const usableLabels = usable.map(item => `${item.account === 'primary' ? 'API 1' : 'API 2'} (${getPreset(slotId, item.config.providerId).name})`);
            const failedLabels = failed.map(item => `${item.account === 'primary' ? 'API 1' : 'API 2'} (${getPreset(slotId, item.config.providerId).name}) failed: ${escapeHtml(redactKeys(describeConnectionTestFailure(item.result)))}`);
            reports.push(`<li class="${failed.length ? 'info' : 'pass'}"><strong>${escapeHtml(slotTitle)}</strong>: ${tested.map(item => `${item.account === 'primary' ? 'API 1' : 'API 2'} (${getPreset(slotId, item.config.providerId).name}) ${item.result.ok ? 'PASS' : 'FAIL'}`).join(' · ')}${skippedAccounts.length ? ` · ${skippedAccounts.join(' · ')}` : ''} — <strong>Saved</strong>. Available: ${usableLabels.join(' · ')}.${failedLabels.length ? ` Failed account isolated: ${failedLabels.join(' · ')}.` : ''}</li>`);
          } catch (saveError) {
            try {
              if (previousPrimary) await saveSlotConnectionTestResult(slotId, previousPrimary);
              else await clearSlotConnectionTestResult(slotId);
              await saveSecondarySlotConfig(slotId, previousSecondary);
              if (previousLastTest) lastTestResults.set(slotId, previousLastTest);
              else lastTestResults.delete(slotId);
              configs[slotId].secondary = previousSecondary;
            } catch {
              // Preserve the original storage failure in the report; rollback is best effort.
            }
            notSavedSlots += 1;
            reports.push(`<li class="fail"><strong>${escapeHtml(slotTitle)}</strong>: At least one API passed, but verification could not be saved: ${escapeHtml(saveError instanceof Error ? saveError.message : String(saveError))}. Previous verification was restored where storage allowed.</li>`);
          }
        } else {
          notSavedSlots += 1;
          const reasons = failed.map(item => `${item.account === 'primary' ? 'API 1' : 'API 2'} (${getPreset(slotId, item.config.providerId).name}) failed: ${escapeHtml(redactKeys(describeConnectionTestFailure(item.result)))}`).join(' · ');
          reports.push(`<li class="fail"><strong>${escapeHtml(slotTitle)}</strong>: ${tested.map(item => `${item.account === 'primary' ? 'API 1' : 'API 2'} (${getPreset(slotId, item.config.providerId).name}) FAIL`).join(' · ')}${skippedAccounts.length ? ` · ${skippedAccounts.join(' · ')}` : ''} — <strong>Not saved</strong>. No configured online account passed. ${reasons}. Previous verification snapshots were preserved; failed accounts retain their own health state.</li>`);
        }

        const primaryResult = lastTestResults.get(slotId);
        const primaryHealth = await getProviderAccountHealth(slotId, 'primary');
        const secondaryHealth = await getProviderAccountHealth(slotId, 'secondary');
        const primaryAvailable = primaryResult?.ok === true && primaryResult.tier !== 3 && !primaryHealth;
        const secondaryConfig = configs[slotId].secondary;
        const secondaryAvailable = !!secondaryConfig?.verified && secondaryConfig.testResult?.ok === true && !secondaryHealth;
        const onlineVerified = primaryAvailable || secondaryAvailable;
        const failedAccount = failed[0]?.account;
        const failedHealth = failedAccount ? await getProviderAccountHealth(slotId, failedAccount) : null;
        const availableLabel = primaryAvailable && secondaryAvailable ? 'both APIs' : primaryAvailable ? 'API 1' : 'API 2';
        const badge = container.querySelector<HTMLElement>(`#badge-${slotId}`);
        if (badge) {
          const badgeLabel = onlineVerified
            ? (failed.length ? `Ready · ${availableLabel} available` : 'Online AI')
            : failedHealth?.state === 'cooldown' ? 'Cooling down'
              : failed.length ? 'Needs re-test' : 'Basic offline';
          badge.className = `tier-badge settings-slot-status ${onlineVerified ? 'online' : failedHealth?.state === 'needs-retest' ? 'error' : 'offline'}`;
          badge.dataset.slotStatus = onlineVerified
            ? (failed.length ? 'ready-degraded' : 'ready')
            : failedHealth?.state === 'cooldown' ? 'cooldown'
              : failed.length ? 'needs-retest' : 'offline';
          badge.innerHTML = `<span class="tier-dot"></span>${badgeLabel}`;
        }
        const primaryStatus = container.querySelector<HTMLElement>(`#status-${slotId}`);
        if (primaryStatus && tested.some(item => item.account === 'primary')) {
          primaryStatus.style.display = '';
          const result = tested.find(item => item.account === 'primary')!.result;
          primaryStatus.className = `status-box ${result.ok ? 'pass' : 'fail'}`;
          primaryStatus.textContent = `API 1 (${getPreset(slotId, result.providerId).name}): ${result.ok ? 'PASS' : 'FAIL'} — ${redactKeys(result.ok ? result.message : describeConnectionTestFailure(result))} · Tested: ${new Date().toLocaleTimeString()}`;
        }
        const secondaryStatus = container.querySelector<HTMLElement>(`#secondary-status-${slotId}`);
        if (secondaryStatus && tested.some(item => item.account === 'secondary')) {
          secondaryStatus.style.display = '';
          const result = tested.find(item => item.account === 'secondary')!.result;
          secondaryStatus.className = `status-box ${result.ok ? 'pass' : 'fail'}`;
          secondaryStatus.textContent = `API 2 (${getPreset(slotId, result.providerId).name}): ${result.ok ? 'PASS' : 'FAIL'} — ${redactKeys(result.ok ? result.message : describeConnectionTestFailure(result))} · Tested: ${new Date().toLocaleTimeString()}`;
        }
        for (const account of ['primary', 'secondary'] as const) {
          if (tested.some(item => item.account === account)) continue;
          const statusBox = container.querySelector<HTMLElement>(account === 'primary' ? `#status-${slotId}` : `#secondary-status-${slotId}`);
          if (statusBox) {
            statusBox.style.display = '';
            statusBox.className = 'status-box info';
            statusBox.textContent = `${account === 'primary' ? 'API 1' : 'API 2'}: ${skippedAccounts.find(reason => reason.startsWith(account === 'primary' ? 'API 1' : 'API 2')) || 'Skipped — not configured'}`;
          }
        }
      }
      backupStatus.className = cancelTestAllApis ? 'status-box info' : notSavedSlots ? 'status-box info' : 'status-box pass';
      backupStatus.innerHTML = `<strong>${savedSlots} slots saved, ${notSavedSlots} not saved, ${skippedSlots} skipped${cancelTestAllApis ? ' — run cancelled; untested slots unchanged' : ''}.</strong><ul class="test-all-api-report">${reports.join('')}</ul>`;
    } catch (error) {
      backupStatus.className = 'status-box fail';
      backupStatus.textContent = `Test all APIs stopped: ${redactKeys(error instanceof Error ? error.message : String(error))}`;
    } finally {
      testAllApisRunning = false;
      settingsProviderTestRunning = false;
      testAllButton.textContent = 'Test all APIs';
      testAllButton.disabled = !hasConfiguredOnlineAccount;
      [...singleTestButtons, ...importButtons].forEach((button, index) => { button.disabled = previousDisabled[index]; });
    }
  });


  // A safer settings-only export deliberately omits credentials and does not
  // persist or alter the API-key fields currently shown in the form.
  const exportNoKeysButton = container.querySelector<HTMLButtonElement>('#export-ai-backup-no-keys');
  exportNoKeysButton?.addEventListener('click', async () => {
    if (exportNoKeysButton) exportNoKeysButton.disabled = true;
    try {
      if (backupStatus) {
        backupStatus.className = 'status-box info';
        backupStatus.textContent = 'Creating a settings-only backup without API keys...';
      }
      const payload = await createBackup('ai-settings', { includeApiKeys: false });
      await downloadBackupFile('ai-settings', payload);
      if (backupStatus) {
        backupStatus.className = 'status-box pass';
        backupStatus.textContent = 'Settings-only backup created. It contains no API keys. Importing it on this device or another device will leave any existing API keys unchanged; configure keys separately on a new device.';
      }
    } catch (error) {
      if (backupStatus) {
        backupStatus.className = 'status-box fail';
        backupStatus.textContent = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (exportNoKeysButton) exportNoKeysButton.disabled = false;
    }
  });

  for (const slotId of SLOT_ORDER) {
    const providerSelect = container.querySelector<HTMLSelectElement>(`#provider-${slotId}`);
    const providerPicker = container.querySelector<HTMLElement>(`#provider-picker-${slotId}`);
    const providerTrigger = container.querySelector<HTMLButtonElement>(`#provider-trigger-${slotId}`);
    const providerOptions = container.querySelector<HTMLElement>(`#provider-options-${slotId}`);
    const baseUrlInput = container.querySelector<HTMLInputElement>(`#baseurl-${slotId}`);
    const baseUrlSummary = baseUrlInput?.closest<HTMLElement>('.advanced-provider-settings')?.querySelector<HTMLElement>('summary');
    const updateBaseUrlPreview = (value: string): void => {
      const preview = baseUrlSummary?.querySelector<HTMLElement>('.settings-url-preview');
      if (preview) { preview.textContent = value; preview.title = value; }
    };
    const keyInput = container.querySelector<HTMLInputElement>(`#key-${slotId}`);
    const modelInput = container.querySelector<HTMLInputElement>(`#model-${slotId}`);
    const modelOptions = container.querySelector<HTMLElement>(`#models-list-${slotId}`);
    const modelPicker = modelOptions?.closest<HTMLElement>('.model-picker-dropdown');
    const modelPickerTrigger = modelPicker?.querySelector<HTMLButtonElement>('.model-picker-trigger');
    const slotBadge = container.querySelector<HTMLElement>(`#badge-${slotId}`);
    const fetchModelsBtn = container.querySelector<HTMLButtonElement>(`#fetch-models-btn-${slotId}`);
    const fetchModelsMsg = container.querySelector<HTMLElement>(`#fetch-models-msg-${slotId}`);

    const closeProviderPicker = (): void => {
      if (providerOptions) providerOptions.hidden = true;
      providerPicker?.classList.remove('open');
      providerTrigger?.setAttribute('aria-expanded', 'false');
    };
    providerTrigger?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!providerOptions) return;
      const opening = providerOptions.hidden;
      providerOptions.hidden = !opening;
      providerPicker?.classList.toggle('open', opening);
      providerTrigger.setAttribute('aria-expanded', String(opening));
      if (opening) {
        const closeOutside = (outsideEvent: Event): void => {
          if (!providerPicker?.contains(outsideEvent.target as Node)) {
            closeProviderPicker();
            document.removeEventListener('pointerdown', closeOutside, true);
          }
        };
        document.addEventListener('pointerdown', closeOutside, true);
      }
    });
    providerOptions?.addEventListener('click', (event) => {
      const option = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-provider-id]');
      if (!option || !providerSelect) return;
      providerSelect.value = option.dataset.providerId ?? providerSelect.value;
      providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    providerSelect?.addEventListener('change', () => {
      const selected = getPreset(slotId, providerSelect.value);
      if (providerTrigger) providerTrigger.querySelector('span')!.textContent = selected.name;
      providerOptions?.querySelectorAll<HTMLButtonElement>('[data-provider-id]').forEach((option) => {
        option.classList.toggle('active', option.dataset.providerId === selected.id);
      });
      closeProviderPicker();
    });

    const renderModelOptions = (models: string[]): void => {
      if (!modelOptions) return;
      modelOptions.innerHTML = models.map((model) =>
        `<button type="button" class="model-option" data-model-value="${escapeHtml(model)}">${escapeHtml(model)}</button>`
      ).join('');
    };

    const closeModelPicker = (): void => {
      if (modelOptions) modelOptions.hidden = true;
      modelPicker?.classList.remove('open');
      modelPickerTrigger?.setAttribute('aria-expanded', 'false');
    };

    modelPickerTrigger?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!modelOptions) return;
      const willOpen = modelOptions.hidden;
      modelOptions.hidden = !willOpen;
      modelPicker?.classList.toggle('open', willOpen);
      modelPickerTrigger.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) {
        const closeOnOutside = (outsideEvent: Event): void => {
          if (!modelPicker?.contains(outsideEvent.target as Node)) {
            closeModelPicker();
            document.removeEventListener('pointerdown', closeOnOutside, true);
          }
        };
        document.addEventListener('pointerdown', closeOnOutside, true);
      }
    });

    modelOptions?.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const option = target.closest<HTMLButtonElement>('[data-model-value]');
      if (!option || !modelInput) return;
      modelInput.value = option.dataset.modelValue ?? '';
      modelInput.dispatchEvent(new Event('input', { bubbles: true }));
      closeModelPicker();
    });

    const copyKeySelect = container.querySelector<HTMLSelectElement>(`#copy-key-source-${slotId}`);
    const copyKeyBtn = container.querySelector<HTMLButtonElement>(`#copy-key-btn-${slotId}`);
    const copyKeyPicker = container.querySelector<HTMLElement>(`#copy-key-picker-${slotId}`);
    const copyKeyTrigger = container.querySelector<HTMLButtonElement>(`#copy-key-trigger-${slotId}`);
    const copyKeyOptions = container.querySelector<HTMLElement>(`#copy-key-options-${slotId}`);
    copyKeyTrigger?.addEventListener('click', () => {
      const isOpen = copyKeyTrigger.getAttribute('aria-expanded') === 'true';
      copyKeyTrigger.setAttribute('aria-expanded', String(!isOpen));
      if (copyKeyOptions) copyKeyOptions.hidden = isOpen;
      copyKeyPicker?.classList.toggle('open', !isOpen);
    });
    copyKeyOptions?.addEventListener('click', (event) => {
      const option = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-key-source]');
      if (!option || !copyKeySelect || !copyKeyTrigger) return;
      const source = option.dataset.copyKeySource ?? '';
      copyKeySelect.value = source;
      const label = copyKeySelect.selectedOptions[0]?.textContent ?? 'Choose source';
      const triggerLabel = copyKeyTrigger.querySelector('span');
      if (triggerLabel) triggerLabel.textContent = label;
      copyKeyOptions.querySelectorAll('[data-copy-key-source]').forEach((node) => node.classList.toggle('active', node === option));
      copyKeyTrigger.setAttribute('aria-expanded', 'false');
      copyKeyOptions.hidden = true;
      copyKeyPicker?.classList.remove('open');
    });

    const authStyleSelect = container.querySelector<HTMLSelectElement>(`#authstyle-${slotId}`);
    const customHeaderInput = container.querySelector<HTMLInputElement>(`#custom-header-${slotId}`);
    const customQueryInput = container.querySelector<HTMLInputElement>(`#custom-query-${slotId}`);
    const endpointPathInput = container.querySelector<HTMLInputElement>(`#endpoint-path-${slotId}`);
    const customVoiceInput = container.querySelector<HTMLInputElement>(`#custom-voice-${slotId}`);

    const customAuthContainer = container.querySelector<HTMLElement>(`#custom-auth-container-${slotId}`);
    const advancedAuthDetails = container.querySelector<HTMLElement>(`#advanced-auth-${slotId}`);
    const customHeaderContainer = container.querySelector<HTMLElement>(`#custom-header-container-${slotId}`);
    const customQueryContainer = container.querySelector<HTMLElement>(`#custom-query-container-${slotId}`);
    const customEndpointContainer = container.querySelector<HTMLElement>(`#custom-endpoint-container-${slotId}`);
    const customVoiceContainer = container.querySelector<HTMLElement>(`#tts-voice-container-${slotId}`);

    const secondaryEnabledToggle = container.querySelector<HTMLInputElement>(`#secondary-api-enabled-${slotId}`);
    const secondaryContent = container.querySelector<HTMLElement>(`#secondary-api-content-${slotId}`);
    const secondaryProviderSelect = container.querySelector<HTMLSelectElement>(`#secondary-provider-${slotId}`);
    const secondaryProviderPicker = container.querySelector<HTMLElement>(`#secondary-provider-picker-${slotId}`);
    const secondaryProviderTrigger = container.querySelector<HTMLButtonElement>(`#secondary-provider-trigger-${slotId}`);
    const secondaryProviderOptions = container.querySelector<HTMLElement>(`#secondary-provider-options-${slotId}`);
    const secondaryBaseUrlInput = container.querySelector<HTMLInputElement>(`#secondary-baseurl-${slotId}`);
    const secondaryModelInput = container.querySelector<HTMLInputElement>(`#secondary-model-${slotId}`);
    const fetchSecondaryModelsBtn = container.querySelector<HTMLButtonElement>(`#fetch-secondary-models-btn-${slotId}`);
    const secondaryModelsList = container.querySelector<HTMLElement>(`#secondary-models-list-${slotId}`);
    const secondaryModelPicker = secondaryModelsList?.closest<HTMLElement>('.model-picker-dropdown');
    const secondaryModelPickerTrigger = secondaryModelPicker?.querySelector<HTMLButtonElement>('.model-picker-trigger');
    const renderSecondaryModelOptions = (models: string[]): void => {
      if (!secondaryModelsList) return;
      secondaryModelsList.innerHTML = models.map((model) =>
        `<button type="button" class="model-option" data-model-value="${escapeHtml(model)}">${escapeHtml(model)}</button>`
      ).join('');
    };
    const closeSecondaryModelPicker = (): void => {
      if (secondaryModelsList) secondaryModelsList.hidden = true;
      secondaryModelPicker?.classList.remove('open');
      secondaryModelPickerTrigger?.setAttribute('aria-expanded', 'false');
    };
    secondaryModelPickerTrigger?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!secondaryModelsList) return;
      const opening = secondaryModelsList.hidden;
      secondaryModelsList.hidden = !opening;
      secondaryModelPicker?.classList.toggle('open', opening);
      secondaryModelPickerTrigger.setAttribute('aria-expanded', String(opening));
      if (opening) {
        const closeOutside = (outsideEvent: Event): void => {
          if (!secondaryModelPicker?.contains(outsideEvent.target as Node)) {
            closeSecondaryModelPicker();
            document.removeEventListener('pointerdown', closeOutside, true);
          }
        };
        document.addEventListener('pointerdown', closeOutside, true);
      }
    });
    const fetchSecondaryModelsMsg = container.querySelector<HTMLElement>(`#fetch-secondary-models-msg-${slotId}`);
    secondaryModelsList?.addEventListener('click', (event) => {
      const option = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-model-value]');
      if (!option || !secondaryModelInput) return;
      secondaryModelInput.value = option.dataset.modelValue ?? '';
      secondaryModelInput.dispatchEvent(new Event('input', { bubbles: true }));
      closeSecondaryModelPicker();
    });
    fetchSecondaryModelsBtn?.addEventListener('click', async () => {
      if (!fetchSecondaryModelsMsg || !secondaryProviderSelect?.value) return;
      fetchSecondaryModelsBtn.disabled = true;
      fetchSecondaryModelsMsg.hidden = false;
      fetchSecondaryModelsMsg.style.color = 'var(--text-secondary)';
      fetchSecondaryModelsMsg.textContent = 'Fetching models from endpoint...';
      try {
        const preset = getPreset(slotId, secondaryProviderSelect.value);
        const cfg: SlotConfig = {
          slotId,
          providerId: preset.id,
          baseUrl: secondaryBaseUrlInput?.value.trim() || preset.defaultBaseUrl,
          modelOrVoice: secondaryModelInput?.value.trim() || preset.defaultModelOrVoice,
          authStyle: (secondaryAuthSelect?.value as AuthStyle) || 'bearer',
          customHeaderName: secondaryHeaderInput?.value.trim() || undefined,
          customQueryParamName: secondaryQueryInput?.value.trim() || undefined,
          endpointPathOverride: secondaryEndpointInput?.value.trim() || undefined
        };
        const key = secondaryKeyInput?.value.trim() || await readKeyForSettings(slotId, preset.id, 'secondary');
        const res = await fetchAvailableModels(cfg, key);
        if (res.supported && res.models.length > 0) {
          fetchSecondaryModelsMsg.style.color = 'var(--success)';
          fetchSecondaryModelsMsg.textContent = `${res.message} Suggestions added to the list.`;
          renderSecondaryModelOptions(res.models);
        } else {
          fetchSecondaryModelsMsg.style.color = res.supported ? 'var(--warning)' : 'var(--danger, #ef4444)';
          fetchSecondaryModelsMsg.textContent = res.message;
        }
      } catch (error) {
        fetchSecondaryModelsMsg.style.color = 'var(--danger, #ef4444)';
        fetchSecondaryModelsMsg.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        fetchSecondaryModelsBtn.disabled = false;
      }
    });
    const secondaryCustomVoiceInput = container.querySelector<HTMLInputElement>(`#secondary-custom-voice-${slotId}`);
    const secondaryCustomVoiceContainer = container.querySelector<HTMLElement>(`#secondary-tts-voice-container-${slotId}`);
    const secondaryKeyInput = container.querySelector<HTMLInputElement>(`#secondary-key-${slotId}`);
    const secondaryCopyKeySelect = container.querySelector<HTMLSelectElement>(`#secondary-copy-key-source-${slotId}`);
    const secondaryCopyKeyBtn = container.querySelector<HTMLButtonElement>(`#secondary-copy-key-btn-${slotId}`);
    const secondaryCopyKeyPicker = container.querySelector<HTMLElement>(`#secondary-copy-key-picker-${slotId}`);
    const secondaryCopyKeyTrigger = container.querySelector<HTMLButtonElement>(`#secondary-copy-key-trigger-${slotId}`);
    const secondaryCopyKeyOptions = container.querySelector<HTMLElement>(`#secondary-copy-key-options-${slotId}`);
    const secondaryAuthSelect = container.querySelector<HTMLSelectElement>(`#secondary-authstyle-${slotId}`);
    const secondaryHeaderInput = container.querySelector<HTMLInputElement>(`#secondary-custom-header-${slotId}`);
    const secondaryQueryInput = container.querySelector<HTMLInputElement>(`#secondary-custom-query-${slotId}`);
    const secondaryEndpointInput = container.querySelector<HTMLInputElement>(`#secondary-endpoint-${slotId}`);
    const fetchVoicesBtn = container.querySelector<HTMLButtonElement>(`#fetch-voices-btn-${slotId}`);
    const voicesList = container.querySelector<HTMLElement>(`#voices-list-${slotId}`);
    const fetchVoicesMsg = container.querySelector<HTMLElement>(`#fetch-voices-msg-${slotId}`);
    const fetchSecondaryVoicesBtn = container.querySelector<HTMLButtonElement>(`#fetch-secondary-voices-btn-${slotId}`);
    const secondaryVoicesList = container.querySelector<HTMLElement>(`#secondary-voices-list-${slotId}`);
    const fetchSecondaryVoicesMsg = container.querySelector<HTMLElement>(`#fetch-secondary-voices-msg-${slotId}`);
    const secondaryTestBtn = container.querySelector<HTMLButtonElement>(`#test-secondary-${slotId}`);
    const secondaryStatus = container.querySelector<HTMLElement>(`#secondary-status-${slotId}`);
    const saveStatus = container.querySelector<HTMLElement>(`#save-status-${slotId}`);
    const saveBtn = container.querySelector<HTMLButtonElement>(`[data-save-slot="${slotId}"]`);
    const testBtn = container.querySelector<HTMLButtonElement>(`[data-test-slot="${slotId}"]`);
    const statusBox = container.querySelector<HTMLElement>(`#status-${slotId}`);

    const ignoreVerificationErrorBtn = container.querySelector<HTMLButtonElement>(`[data-ignore-verification-error="${slotId}"]`);
    const verificationActions = container.querySelector<HTMLElement>(`#verification-actions-${slotId}`);
    const mismatchWarningBox = container.querySelector<HTMLElement>(`#mismatch-warning-${slotId}`);
    const mismatchWarningText = container.querySelector<HTMLElement>(`#mismatch-warning-text-${slotId}`);
    const switchCustomBtn = container.querySelector<HTMLButtonElement>(`#switch-custom-btn-${slotId}`);
    const secondaryMismatchWarningBox = container.querySelector<HTMLElement>(`#secondary-mismatch-warning-${slotId}`);
    const secondaryMismatchWarningText = container.querySelector<HTMLElement>(`#secondary-mismatch-warning-text-${slotId}`);
    const switchSecondaryCustomBtn = container.querySelector<HTMLButtonElement>(`#secondary-switch-custom-btn-${slotId}`);

    const markSlotNotVerified = (message = 'Unsaved or changed settings. Save this slot, then pass the test to activate Online AI.'): void => {
      dismissedVerificationErrors.delete(slotId);
      if (statusBox) statusBox.style.display = '';
      if (verificationActions) verificationActions.style.display = 'flex';
      if (slotBadge) {
        slotBadge.className = 'tier-badge offline';
        slotBadge.innerHTML = '<span class="tier-dot"></span>Not verified';
      }
      if (statusBox) {
        statusBox.className = 'status-box info';
        statusBox.textContent = message;
      }
    };

    const bindVoicePicker = (
      button: HTMLButtonElement | null,
      list: HTMLElement | null,
      message: HTMLElement | null,
      voiceInput: HTMLInputElement | null,
      buildConfig: () => SlotConfig,
      getKey: () => string | Promise<string>
    ): void => {
      button?.addEventListener('click', async () => {
        if (!button || !list || !message || !voiceInput) return;
        button.disabled = true;
        message.hidden = false;
        message.className = 'settings-fetch-models-message';
        message.textContent = 'Loading voices…';
        try {
          const result = await fetchAvailableTtsVoices(buildConfig(), await getKey());
          list.innerHTML = result.voices.map((voice) =>
            `<button type="button" class="model-option" data-tts-voice="${escapeHtml(voice.value)}">${escapeHtml(voice.label)}</button>`
          ).join('');
          list.hidden = result.voices.length === 0;
          message.textContent = result.message;
        } catch (error) {
          list.hidden = true;
          message.textContent = error instanceof Error ? error.message : String(error);
          message.className = 'settings-fetch-models-message error';
        } finally {
          button.disabled = false;
        }
      });
      list?.addEventListener('click', (event) => {
        const option = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tts-voice]');
        if (!option || !voiceInput) return;
        voiceInput.value = option.dataset.ttsVoice ?? '';
        voiceInput.dispatchEvent(new Event('input', { bubbles: true }));
        if (list) list.hidden = true;
      });
    };

    if (slotId === 'voice_tts') {
      const previewVoice = async (
        button: HTMLButtonElement | null,
        message: HTMLElement | null,
        buildConfig: () => SlotConfig,
        getKey: () => string | Promise<string>
      ): Promise<void> => {
        if (!button || !message) return;
        button.addEventListener('click', async () => {
          button.disabled = true;
          message.hidden = false;
          message.className = 'settings-fetch-models-message';
          message.textContent = 'Generating voice preview…';
          try {
            await previewTtsVoice(buildConfig(), await getKey());
            message.textContent = 'Preview finished. The configured voice (or provider default if no voice is selected) was used.';
          } catch (error) {
            message.className = 'settings-fetch-models-message error';
            message.textContent = error instanceof Error ? error.message : String(error);
          } finally {
            button.disabled = false;
          }
        });
      };
      const buildPrimaryTtsConfig = (): SlotConfig => {
        const selected = getPreset('voice_tts', providerSelect?.value ?? configs.voice_tts.providerId);
        return {
          slotId: 'voice_tts',
          providerId: selected.id,
          baseUrl: baseUrlInput?.value.trim() || selected.defaultBaseUrl,
          modelOrVoice: modelInput?.value.trim() || selected.defaultModelOrVoice,
          authStyle: (authStyleSelect?.value as AuthStyle) || 'bearer',
          customHeaderName: customHeaderInput?.value.trim() || undefined,
          customQueryParamName: customQueryInput?.value.trim() || undefined,
          endpointPathOverride: endpointPathInput?.value.trim() || undefined,
          customTtsVoice: customVoiceInput?.value.trim() || undefined
        };
      };
      const buildSecondaryTtsConfig = (): SlotConfig => {
        const providerId = secondaryProviderSelect?.value ?? '';
        if (!providerId) throw new Error('Choose an API 2 provider first.');
        const selected = getPreset('voice_tts', providerId);
        return {
          slotId: 'voice_tts',
          providerId: selected.id,
          baseUrl: secondaryBaseUrlInput?.value.trim() || selected.defaultBaseUrl,
          modelOrVoice: secondaryModelInput?.value.trim() || selected.defaultModelOrVoice,
          authStyle: (secondaryAuthSelect?.value as AuthStyle) || 'bearer',
          customHeaderName: secondaryHeaderInput?.value.trim() || undefined,
          customQueryParamName: secondaryQueryInput?.value.trim() || undefined,
          endpointPathOverride: secondaryEndpointInput?.value.trim() || undefined,
          customTtsVoice: secondaryCustomVoiceInput?.value.trim() || undefined
        };
      };
      void previewVoice(
        container.querySelector<HTMLButtonElement>(`#preview-voice-btn-${slotId}`),
        container.querySelector<HTMLElement>(`#preview-voice-msg-${slotId}`),
        buildPrimaryTtsConfig,
        () => keyInput?.value.trim() || readKeyForSettings('voice_tts', providerSelect?.value ?? configs.voice_tts.providerId)
      );
      void previewVoice(
        container.querySelector<HTMLButtonElement>(`#preview-secondary-voice-btn-${slotId}`),
        container.querySelector<HTMLElement>(`#preview-secondary-voice-msg-${slotId}`),
        buildSecondaryTtsConfig,
        () => secondaryKeyInput?.value.trim() || readKeyForSettings('voice_tts', secondaryProviderSelect?.value ?? '', 'secondary')
      );
      bindVoicePicker(
        fetchVoicesBtn, voicesList, fetchVoicesMsg, customVoiceInput,
        () => {
          const selected = getPreset('voice_tts', providerSelect?.value ?? configs.voice_tts.providerId);
          return {
            slotId: 'voice_tts',
            providerId: selected.id,
            baseUrl: baseUrlInput?.value.trim() || selected.defaultBaseUrl,
            modelOrVoice: modelInput?.value.trim() || selected.defaultModelOrVoice,
            authStyle: (authStyleSelect?.value as AuthStyle) || 'bearer',
            customHeaderName: customHeaderInput?.value.trim() || undefined,
            customQueryParamName: customQueryInput?.value.trim() || undefined,
            endpointPathOverride: endpointPathInput?.value.trim() || undefined,
            customTtsVoice: customVoiceInput?.value.trim() || undefined
          };
        },
        () => {
          const providerId = providerSelect?.value ?? configs.voice_tts.providerId;
          return keyInput?.value.trim() || readKeyForSettings('voice_tts', providerId);
        }
      );
      bindVoicePicker(
        fetchSecondaryVoicesBtn, secondaryVoicesList, fetchSecondaryVoicesMsg, secondaryCustomVoiceInput,
        () => {
          const providerId = secondaryProviderSelect?.value ?? '';
          if (!providerId) throw new Error('Choose an API 2 provider first.');
          const selected = getPreset('voice_tts', providerId);
          return {
            slotId: 'voice_tts',
            providerId: selected.id,
            baseUrl: secondaryBaseUrlInput?.value.trim() || selected.defaultBaseUrl,
            modelOrVoice: secondaryModelInput?.value.trim() || selected.defaultModelOrVoice,
            authStyle: (secondaryAuthSelect?.value as AuthStyle) || 'bearer',
            customHeaderName: secondaryHeaderInput?.value.trim() || undefined,
            customQueryParamName: secondaryQueryInput?.value.trim() || undefined,
            endpointPathOverride: secondaryEndpointInput?.value.trim() || undefined,
            customTtsVoice: secondaryCustomVoiceInput?.value.trim() || undefined
          };
        },
        () => {
          const providerId = secondaryProviderSelect?.value ?? '';
          return providerId ? (secondaryKeyInput?.value.trim() || readKeyForSettings('voice_tts', providerId, 'secondary')) : '';
        }
      );
    }

    // Any edit invalidates the visible verified state immediately. The saved
    // configuration remains unchanged until Save Slot is pressed.
    [baseUrlInput, keyInput, modelInput, customHeaderInput, customQueryInput, endpointPathInput, customVoiceInput].forEach((field) => {
      field?.addEventListener('input', () => {
        markSlotNotVerified('Unsaved changes. Save this slot, then pass the connection test to activate Online AI.');
      });
    });
    const secondaryCustomHeaderContainer = container.querySelector<HTMLElement>(`#secondary-custom-header-container-${slotId}`);
    const secondaryCustomQueryContainer = container.querySelector<HTMLElement>(`#secondary-custom-query-container-${slotId}`);
    secondaryAuthSelect?.addEventListener('change', () => {
      if (secondaryCustomHeaderContainer) secondaryCustomHeaderContainer.style.display = secondaryAuthSelect.value === 'custom_header' ? '' : 'none';
      if (secondaryCustomQueryContainer) secondaryCustomQueryContainer.style.display = secondaryAuthSelect.value === 'query_param' ? '' : 'none';
      if (secondaryStatus) { secondaryStatus.className = 'status-box info'; secondaryStatus.textContent = 'API 2: Changes not tested'; }
    });

    const closeSecondaryProviderPicker = (): void => {
      if (secondaryProviderOptions) secondaryProviderOptions.hidden = true;
      secondaryProviderPicker?.classList.remove('open');
      secondaryProviderTrigger?.setAttribute('aria-expanded', 'false');
    };
    secondaryProviderTrigger?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!secondaryProviderOptions) return;
      const opening = secondaryProviderOptions.hidden;
      secondaryProviderOptions.hidden = !opening;
      secondaryProviderPicker?.classList.toggle('open', opening);
      secondaryProviderTrigger.setAttribute('aria-expanded', String(opening));
      if (opening) {
        const closeOutside = (outsideEvent: Event): void => {
          if (!secondaryProviderPicker?.contains(outsideEvent.target as Node)) {
            closeSecondaryProviderPicker();
            document.removeEventListener('pointerdown', closeOutside, true);
          }
        };
        document.addEventListener('pointerdown', closeOutside, true);
      }
    });
    secondaryProviderOptions?.addEventListener('click', (event) => {
      const option = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-secondary-provider-id]');
      if (!option || !secondaryProviderSelect) return;
      secondaryProviderSelect.value = option.dataset.secondaryProviderId ?? '';
      secondaryProviderSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    secondaryEnabledToggle?.addEventListener('change', () => {
      if (!secondaryEnabledToggle.checked) {
        if (secondaryContent) secondaryContent.hidden = true;
        if (secondaryProviderSelect) {
          secondaryProviderSelect.value = '';
          secondaryProviderSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (secondaryTestBtn) secondaryTestBtn.hidden = true;
        if (secondaryStatus) secondaryStatus.hidden = true;
        return;
      }
      if (secondaryContent) secondaryContent.hidden = false;
      if (secondaryTestBtn) secondaryTestBtn.hidden = false;
      if (secondaryStatus) secondaryStatus.hidden = false;
      if (secondaryProviderSelect && !secondaryProviderSelect.value) {
        const candidates = SLOT_DEFINITIONS[slotId].providers.filter((provider) => provider.tier !== 3);
        const next = candidates.find((provider) => provider.id !== providerSelect?.value) ?? candidates[0];
        if (next) {
          secondaryProviderSelect.value = next.id;
          secondaryProviderSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });
    if (secondaryEnabledToggle && !secondaryEnabledToggle.checked) {
      if (secondaryTestBtn) secondaryTestBtn.hidden = true;
      if (secondaryStatus) secondaryStatus.hidden = true;
    }

    secondaryProviderSelect?.addEventListener('change', () => {
      const selected = secondaryProviderSelect.value;
      if (secondaryProviderTrigger) secondaryProviderTrigger.querySelector('span')!.textContent = selected ? getPreset(slotId, selected).name : 'Not configured';
      secondaryProviderOptions?.querySelectorAll<HTMLButtonElement>('[data-secondary-provider-id]').forEach((option) => option.classList.toggle('active', option.dataset.secondaryProviderId === selected));
      closeSecondaryProviderPicker();
      if (!selected) {
        const customAuth = container.querySelector<HTMLElement>(`#secondary-custom-auth-container-${slotId}`);
        if (customAuth) customAuth.style.display = 'none';
        if (secondaryBaseUrlInput) secondaryBaseUrlInput.value = '';
        if (secondaryModelInput) secondaryModelInput.value = '';
        if (secondaryCustomVoiceInput) secondaryCustomVoiceInput.value = '';
        if (secondaryCustomVoiceContainer) secondaryCustomVoiceContainer.style.display = 'none';
        if (secondaryKeyInput) { secondaryKeyInput.value = ''; secondaryKeyInput.disabled = true; secondaryKeyInput.placeholder = 'Choose a provider first'; }
        renderSecondaryModelOptions([]);
        updateSecondaryMismatchWarning();
        if (secondaryStatus) { secondaryStatus.className = 'status-box info'; secondaryStatus.textContent = 'API 2: Not configured'; }
        return;
      }
      const selectedPreset = getPreset(slotId, selected);
      renderSecondaryModelOptions(selectedPreset.modelSuggestions || [selectedPreset.defaultModelOrVoice]);
      const secondaryCustomAuthContainer = container.querySelector<HTMLElement>(`#secondary-custom-auth-container-${slotId}`);
      if (secondaryCustomAuthContainer) secondaryCustomAuthContainer.style.display = selectedPreset.id.startsWith('custom_openai_') ? '' : 'none';
      if (secondaryKeyInput) secondaryKeyInput.disabled = !selectedPreset.requiresKey;
      if (!selectedPreset.requiresKey && secondaryKeyInput) {
        secondaryKeyInput.value = '';
        secondaryKeyInput.placeholder = 'No API key needed';
      }
      if (secondaryProviderSelect.value !== configs[slotId].secondary?.providerId && secondaryKeyInput && selectedPreset.requiresKey) {
        secondaryKeyInput.value = '';
        secondaryKeyInput.placeholder = 'Enter second API key';
        void readKeyForSettings(slotId, selectedPreset.id, 'secondary').then((storedKey) => {
          if (!secondaryKeyInput) return;
          secondaryKeyInput.placeholder = storedKey
            ? 'API 2 key is stored securely. Leave blank to keep it, or type a replacement.'
            : 'Enter second API key';
        });
      }
      if (secondaryBaseUrlInput) secondaryBaseUrlInput.value = selectedPreset.defaultBaseUrl;
      if (secondaryModelInput) secondaryModelInput.value = selectedPreset.defaultModelOrVoice;
      if (secondaryCustomVoiceInput) secondaryCustomVoiceInput.value = '';
      if (secondaryCustomVoiceContainer) secondaryCustomVoiceContainer.style.display = selectedPreset.id === 'android_native_tts' ? 'none' : '';
      updateSecondaryMismatchWarning();
      if (secondaryStatus) { secondaryStatus.className = 'status-box info'; secondaryStatus.textContent = 'API 2: Changes not tested'; }
    });
    [secondaryProviderSelect, secondaryBaseUrlInput, secondaryModelInput, secondaryCustomVoiceInput, secondaryKeyInput, secondaryAuthSelect, secondaryHeaderInput, secondaryQueryInput, secondaryEndpointInput].forEach((field) => {
      field?.addEventListener('input', () => { if (secondaryStatus) { secondaryStatus.className = 'status-box info'; secondaryStatus.textContent = 'API 2: Changes not tested'; } });
      field?.addEventListener('change', () => { if (secondaryStatus) { secondaryStatus.className = 'status-box info'; secondaryStatus.textContent = 'API 2: Changes not tested'; } });
    });
    [authStyleSelect].forEach((field) => field?.addEventListener('change', () => {
      markSlotNotVerified('Unsaved changes. Save this slot, then pass test to activate Online AI.');
    }));

    const updateSecondaryMismatchWarning = (): void => {
      if (!secondaryMismatchWarningBox || !secondaryMismatchWarningText) return;
      const selectedProviderId = secondaryProviderSelect?.value ?? '';
      if (!selectedProviderId) { secondaryMismatchWarningBox.style.display = 'none'; return; }
      const preset = getPreset(slotId, selectedProviderId);
      const check = detectProviderUrlMismatch({ slotId, providerId: preset.id, baseUrl: secondaryBaseUrlInput?.value.trim() || preset.defaultBaseUrl, endpointPathOverride: secondaryEndpointInput?.value.trim() || undefined });
      if (check.mismatch) {
        secondaryMismatchWarningBox.style.display = '';
        secondaryMismatchWarningText.textContent = check.reason ?? '';
      } else {
        secondaryMismatchWarningBox.style.display = 'none';
      }
    };

    const updateMismatchWarning = () => {
      if (!mismatchWarningBox || !mismatchWarningText) return;
      const selectedProviderId = providerSelect?.value ?? configs[slotId].providerId;
      const preset = getPreset(slotId, selectedProviderId);
      const check = detectProviderUrlMismatch({
        slotId,
        providerId: preset.id,
        baseUrl: baseUrlInput?.value.trim() || preset.defaultBaseUrl,
        endpointPathOverride: endpointPathInput?.value.trim() || undefined
      });
      if (check.mismatch) {
        mismatchWarningBox.style.display = '';
        mismatchWarningText.textContent = check.reason ?? '';
      } else {
        mismatchWarningBox.style.display = 'none';
      }
    };

    baseUrlInput?.addEventListener('input', () => {
      updateBaseUrlPreview(baseUrlInput.value.trim() || getPreset(slotId, providerSelect?.value ?? configs[slotId].providerId).defaultBaseUrl);
      updateMismatchWarning();
    });
    endpointPathInput?.addEventListener('input', updateMismatchWarning);
    secondaryBaseUrlInput?.addEventListener('input', updateSecondaryMismatchWarning);
    secondaryEndpointInput?.addEventListener('input', updateSecondaryMismatchWarning);

    // One-click "Switch to Custom (OpenAI-compatible)" preserving current Base URL, model, and API key
    switchCustomBtn?.addEventListener('click', async () => {
      const customProviderId = getCustomProviderIdForSlot(slotId);
      const customPreset = getPreset(slotId, customProviderId);
      const currentBaseUrl = baseUrlInput?.value.trim() || customPreset.defaultBaseUrl;
      const currentModel = modelInput?.value.trim() || customPreset.defaultModelOrVoice;
      const currentProviderId = providerSelect?.value ?? configs[slotId].providerId;
      const currentKey = keyInput?.value.trim() || await readKeyForSettings(slotId, currentProviderId);

      if (providerSelect) {
        providerSelect.value = customPreset.id;
        // Run the normal provider-change path so the picker label, custom
        // endpoint/auth fields, model suggestions and key state stay in sync.
        providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (baseUrlInput) baseUrlInput.value = currentBaseUrl;
      if (modelInput) modelInput.value = currentModel;
      if (keyInput) keyInput.value = currentKey;
      if (currentKey.trim()) {
        // Preserve the key under the newly selected provider, but leave the
        // provider configuration unsaved and unverified until Save + test.
        try {
          await saveApiKey(slotId, customPreset.id, currentKey);
          if (slotId === 'voice_tts') {
            await clearActiveShadowingAudioStore();
            clearGeminiLanguageFailures('gemini_tts');
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (saveStatus) {
            saveStatus.hidden = false;
            saveStatus.className = 'status-box fail settings-save-status';
            saveStatus.textContent = `API key was not copied to the custom provider: ${message}`;
          }
          return;
        }
      }
      if (keyInput) {
        keyInput.value = '';
        keyInput.placeholder = currentKey ? 'Key saved securely. Leave blank to keep it, or type a replacement.' : 'Enter your API key...';
      }
      if (customAuthContainer) customAuthContainer.style.display = '';
      if (customEndpointContainer) customEndpointContainer.style.display = '';
      markSlotNotVerified('Custom provider selected. Save this slot, then pass test to activate Online AI.');
    });

    switchSecondaryCustomBtn?.addEventListener('click', async () => {
      const customProviderId = getCustomProviderIdForSlot(slotId);
      const customPreset = getPreset(slotId, customProviderId);
      const currentProviderId = secondaryProviderSelect?.value ?? '';
      if (!currentProviderId || !secondaryProviderSelect) return;
      const currentBaseUrl = secondaryBaseUrlInput?.value.trim() || customPreset.defaultBaseUrl;
      const currentModel = secondaryModelInput?.value.trim() || customPreset.defaultModelOrVoice;
      const currentKey = secondaryKeyInput?.value.trim() || await readKeyForSettings(slotId, currentProviderId, 'secondary');

      secondaryProviderSelect.value = customPreset.id;
      secondaryProviderSelect.dispatchEvent(new Event('change', { bubbles: true }));
      if (secondaryBaseUrlInput) secondaryBaseUrlInput.value = currentBaseUrl;
      if (secondaryModelInput) secondaryModelInput.value = currentModel;
      if (secondaryKeyInput) secondaryKeyInput.value = currentKey;

      if (currentKey.trim()) {
        try {
          await saveApiKey(slotId, customPreset.id, currentKey, 'secondary');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (saveStatus) {
            saveStatus.hidden = false;
            saveStatus.className = 'status-box fail settings-save-status';
            saveStatus.textContent = `API 2 key was not copied to the custom provider: ${message}`;
          }
          return;
        }
      }
      if (secondaryKeyInput) {
        secondaryKeyInput.value = '';
        secondaryKeyInput.placeholder = currentKey
          ? 'API 2 key saved securely. Leave blank to keep it, or type a replacement.'
          : 'Enter second API key';
      }
      updateSecondaryMismatchWarning();
      if (secondaryStatus) {
        secondaryStatus.className = 'status-box info';
        secondaryStatus.textContent = 'API 2 custom provider selected. Save this slot, then test API 2.';
      }
    });

    switchSecondaryCustomBtn?.addEventListener('click', async () => {
      const customProviderId = getCustomProviderIdForSlot(slotId);
      const customPreset = getPreset(slotId, customProviderId);
      const currentProviderId = secondaryProviderSelect?.value ?? '';
      if (!currentProviderId || !secondaryProviderSelect) return;
      const currentBaseUrl = secondaryBaseUrlInput?.value.trim() || customPreset.defaultBaseUrl;
      const currentModel = secondaryModelInput?.value.trim() || customPreset.defaultModelOrVoice;
      const currentKey = secondaryKeyInput?.value.trim() || await readKeyForSettings(slotId, currentProviderId, 'secondary');

      secondaryProviderSelect.value = customPreset.id;
      secondaryProviderSelect.dispatchEvent(new Event('change', { bubbles: true }));
      if (secondaryBaseUrlInput) secondaryBaseUrlInput.value = currentBaseUrl;
      if (secondaryModelInput) secondaryModelInput.value = currentModel;
      if (secondaryKeyInput) secondaryKeyInput.value = currentKey;

      if (currentKey.trim()) {
        try {
          await saveApiKey(slotId, customPreset.id, currentKey, 'secondary');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (saveStatus) {
            saveStatus.hidden = false;
            saveStatus.className = 'status-box fail settings-save-status';
            saveStatus.textContent = `API 2 key was not copied to the custom provider: ${message}`;
          }
          return;
        }
      }
      if (secondaryKeyInput) {
        secondaryKeyInput.value = '';
        secondaryKeyInput.placeholder = currentKey
          ? 'API 2 key saved securely. Leave blank to keep it, or type a replacement.'
          : 'Enter second API key';
      }
      updateSecondaryMismatchWarning();
      if (secondaryStatus) {
        secondaryStatus.className = 'status-box info';
        secondaryStatus.textContent = 'API 2 custom provider selected. Save this slot, then test API 2.';
      }
    });

    // "Copy key from another slot" click handler
    copyKeyBtn?.addEventListener('click', () => {
      const [sourceSlot, sourceAccount] = (copyKeySelect?.value ?? '').split('|');
      const sourceId = sourceSlot as SlotId | undefined;
      if (!sourceId || !keyInput) return;
      const value = sourceAccount === 'secondary' ? secondaryKeysBySlot[sourceId] : keysBySlot[sourceId];
      if (value?.trim()) {
        keyInput.value = value;
        keyInput.dispatchEvent(new Event('input', { bubbles: true }));
        showToast('API key copied into this field. Save settings to keep the change.');
      } else {
        showToast('No saved API key was found in the selected source.', 'info');
      }
    });

    secondaryCopyKeyTrigger?.addEventListener('click', () => {
      const isOpen = secondaryCopyKeyTrigger.getAttribute('aria-expanded') === 'true';
      secondaryCopyKeyTrigger.setAttribute('aria-expanded', String(!isOpen));
      if (secondaryCopyKeyOptions) secondaryCopyKeyOptions.hidden = isOpen;
      secondaryCopyKeyPicker?.classList.toggle('open', !isOpen);
    });
    secondaryCopyKeyOptions?.addEventListener('click', (event) => {
      const option = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-secondary-copy-key-source]');
      if (!option || !secondaryCopyKeySelect || !secondaryCopyKeyTrigger) return;
      const source = option.dataset.secondaryCopyKeySource ?? '';
      secondaryCopyKeySelect.value = source;
      const label = secondaryCopyKeySelect.selectedOptions[0]?.textContent ?? 'Choose source';
      const triggerLabel = secondaryCopyKeyTrigger.querySelector('span');
      if (triggerLabel) triggerLabel.textContent = label;
      secondaryCopyKeyOptions.querySelectorAll('[data-secondary-copy-key-source]').forEach((node) => node.classList.toggle('active', node === option));
      secondaryCopyKeyTrigger.setAttribute('aria-expanded', 'false');
      secondaryCopyKeyOptions.hidden = true;
      secondaryCopyKeyPicker?.classList.remove('open');
    });
    secondaryCopyKeyBtn?.addEventListener('click', () => {
      const [sourceSlot, sourceAccount] = (secondaryCopyKeySelect?.value ?? '').split('|');
      const sourceId = sourceSlot as SlotId | undefined;
      if (!sourceId || !secondaryKeyInput) return;
      const value = sourceAccount === 'secondary' ? secondaryKeysBySlot[sourceId] : keysBySlot[sourceId];
      if (value?.trim()) {
        secondaryKeyInput.value = value;
        secondaryKeyInput.dispatchEvent(new Event('input', { bubbles: true }));
        showToast('API key copied into this field. Save settings to keep the change.');
      } else {
        showToast('No saved API key was found in the selected source.', 'info');
      }
    });

    // "Fetch models" click handler
    fetchModelsBtn?.addEventListener('click', async () => {
      if (!fetchModelsBtn || !fetchModelsMsg) return;
      fetchModelsBtn.disabled = true;
      fetchModelsMsg.style.display = 'block';
      fetchModelsMsg.style.color = 'var(--text-secondary)';
      fetchModelsMsg.textContent = 'Fetching models from endpoint...';

      const selectedProviderId = providerSelect?.value ?? configs[slotId].providerId;
      const preset = getPreset(slotId, selectedProviderId);
      const currentCfg: SlotConfig = {
        slotId,
        providerId: preset.id,
        baseUrl: baseUrlInput?.value.trim() || preset.defaultBaseUrl,
        modelOrVoice: modelInput?.value.trim() || preset.defaultModelOrVoice,
        authStyle: (authStyleSelect?.value as AuthStyle) || 'bearer',
        customHeaderName: customHeaderInput?.value.trim() || undefined,
        customQueryParamName: customQueryInput?.value.trim() || undefined,
        endpointPathOverride: endpointPathInput?.value.trim() || undefined
      };
      const currentKey = keyInput?.value.trim() || await readKeyForSettings(slotId, preset.id);

      const res = await fetchAvailableModels(currentCfg, currentKey);
      fetchModelsBtn.disabled = false;

      if (res.supported && res.models.length > 0) {
        fetchModelsMsg.style.color = 'var(--success)';
        fetchModelsMsg.textContent = `${res.message} Suggestions added to the list.`;
        renderModelOptions(res.models);
      } else {
        fetchModelsMsg.style.color = res.supported ? 'var(--warning)' : 'var(--danger, #ef4444)';
        fetchModelsMsg.textContent = res.message;
      }
    });

    authStyleSelect?.addEventListener('change', () => {
      const selectedStyle = authStyleSelect.value;
      if (customHeaderContainer) {
        customHeaderContainer.style.display = selectedStyle === 'custom_header' ? '' : 'none';
      }
      if (customQueryContainer) {
        customQueryContainer.style.display = selectedStyle === 'query_param' ? '' : 'none';
      }
    });

    providerSelect?.addEventListener('change', async () => {
      const nextProviderId = providerSelect.value;
      const nextPreset = getPreset(slotId, nextProviderId);
      const isCustomNext = nextPreset.id.startsWith('custom_openai_');
      const showVoiceForNext = nextPreset.id !== 'android_native_tts';

      if (customAuthContainer) customAuthContainer.style.display = isCustomNext ? '' : 'none';
      if (advancedAuthDetails) advancedAuthDetails.style.display = isCustomNext ? '' : 'none';
      if (customEndpointContainer) customEndpointContainer.style.display = isCustomNext ? '' : 'none';
      if (customVoiceContainer) customVoiceContainer.style.display = showVoiceForNext ? '' : 'none';

      // Update datalist suggestions
      const nextSuggestions = nextPreset.modelSuggestions || [nextPreset.defaultModelOrVoice];
      renderModelOptions(nextSuggestions);

      if (baseUrlInput) baseUrlInput.value = nextPreset.defaultBaseUrl;
      updateBaseUrlPreview(nextPreset.defaultBaseUrl);
      if (modelInput) modelInput.value = nextPreset.defaultModelOrVoice;
      if (keyInput) {
        const storedKey = await readKeyForSettings(slotId, nextPreset.id);
        keyInput.value = '';
        keyInput.placeholder = storedKey
          ? 'Key already stored securely. Leave blank to keep it, or type a replacement.'
          : 'Enter your API key...';
      }
      markSlotNotVerified('Provider changed. Save this slot, then pass test to activate Online AI.');
    });

    const persistCurrentSlot = async (): Promise<{ cfg: SlotConfig; key: string; primaryChanged: boolean }> => {
      const selectedProviderId = providerSelect?.value ?? configs[slotId].providerId;
      const preset = getPreset(slotId, selectedProviderId);
      const cfg: SlotConfig = {
        slotId,
        providerId: preset.id,
        baseUrl: baseUrlInput?.value.trim() || preset.defaultBaseUrl,
        modelOrVoice: modelInput?.value.trim() || preset.defaultModelOrVoice,
        speechRate: configs[slotId].speechRate,
        authStyle: (authStyleSelect?.value as AuthStyle) || 'bearer',
        customHeaderName: customHeaderInput?.value.trim() || undefined,
        customQueryParamName: customQueryInput?.value.trim() || undefined,
        endpointPathOverride: endpointPathInput?.value.trim() || undefined,
        customTtsVoice: customVoiceInput?.value.trim() || undefined
      };
      const rawKeyInput = keyInput?.value.trim() ?? '';
      const rawKey = preset.requiresKey
        ? (rawKeyInput || await readKeyForSettings(slotId, preset.id, 'primary'))
        : '';
      const previousConfig = { ...configs[slotId] };
      const primaryChanged = JSON.stringify({ ...configs[slotId], secondary: undefined }) !== JSON.stringify({ ...cfg, secondary: undefined }) || rawKey !== keysBySlot[slotId];
      const secondaryProviderId = secondaryProviderSelect?.value ?? '';
      const secondaryPreset = secondaryProviderId ? getPreset(slotId, secondaryProviderId) : undefined;
      const previousSecondary = configs[slotId].secondary;
      const unreadablePrimaryKey = keyStorageReadErrors.has(`${slotId}|${preset.id}|primary`);
      const unreadableSecondaryKey = !!secondaryPreset && keyStorageReadErrors.has(`${slotId}|${secondaryPreset.id}|secondary`);
      if (unreadablePrimaryKey && !rawKey.trim()) {
        throw new Error('The saved API key for this provider could not be read securely. Do not save an empty key; restore it from an AI Settings backup, enter a replacement key, or choose a different provider.');
      }
      if (unreadableSecondaryKey && !(secondaryKeyInput?.value ?? '').trim()) {
        throw new Error('The saved secondary API key could not be read securely. Do not overwrite it with an empty value; restore it from an AI Settings backup, enter a replacement key, or choose a different secondary provider.');
      }
      const secondaryDraft = secondaryPreset ? {
        providerId: secondaryPreset.id,
        baseUrl: secondaryBaseUrlInput?.value.trim() || secondaryPreset.defaultBaseUrl,
        modelOrVoice: secondaryModelInput?.value.trim() || secondaryPreset.defaultModelOrVoice,
        authStyle: (secondaryAuthSelect?.value as AuthStyle) || 'bearer',
        customHeaderName: secondaryHeaderInput?.value.trim() || undefined,
        customQueryParamName: secondaryQueryInput?.value.trim() || undefined,
        endpointPathOverride: secondaryEndpointInput?.value.trim() || undefined,
        customTtsVoice: secondaryCustomVoiceInput?.value.trim() || undefined
      } : undefined;
      const secondaryUnchanged = !!previousSecondary && !!secondaryDraft &&
        previousSecondary.providerId === secondaryDraft.providerId &&
        previousSecondary.baseUrl === secondaryDraft.baseUrl &&
        previousSecondary.modelOrVoice === secondaryDraft.modelOrVoice &&
        previousSecondary.authStyle === secondaryDraft.authStyle &&
        previousSecondary.customHeaderName === secondaryDraft.customHeaderName &&
        previousSecondary.customQueryParamName === secondaryDraft.customQueryParamName &&
        previousSecondary.endpointPathOverride === secondaryDraft.endpointPathOverride &&
        previousSecondary.customTtsVoice === secondaryDraft.customTtsVoice &&
        ((secondaryKeyInput?.value.trim() ?? '') || secondaryKeysBySlot[slotId]) === secondaryKeysBySlot[slotId];
      const secondaryStillVerified = secondaryUnchanged && previousSecondary?.verified === true;
      cfg.secondary = secondaryDraft
        ? {
            ...secondaryDraft,
            verified: secondaryStillVerified,
            ...(secondaryStillVerified && previousSecondary?.testResult
              ? { testResult: previousSecondary.testResult }
              : {})
          }
        : undefined;

      // Snapshot both old and destination keys before changing anything. This
      // protects the user's current key if a secure write or config save fails.
      const keySnapshots = new Map<string, { providerId: string; account: 'primary' | 'secondary'; value: string }>();
      const rememberKey = async (providerId: string | undefined, account: 'primary' | 'secondary') => {
        if (!providerId) return;
        const errorKey = `${slotId}|${providerId}|${account}`;
        if (keyStorageReadErrors.has(errorKey)) return;
        const key = `${providerId}|${account}`;
        if (!keySnapshots.has(key)) {
          keySnapshots.set(key, {
            providerId,
            account,
            value: await loadApiKeyStrict(slotId, providerId, account)
          });
        }
      };
      await rememberKey(previousConfig.providerId, 'primary');
      await rememberKey(cfg.providerId, 'primary');
      await rememberKey(previousSecondary?.providerId, 'secondary');
      await rememberKey(secondaryDraft?.providerId, 'secondary');

      try {
        // Persist and verify credentials before making the selected provider
        // active in the saved configuration.
        if (preset.requiresKey) {
          if (!rawKey.trim()) throw new Error('Enter an API key or select a provider that already has a saved key.');
          if (rawKeyInput) {
            await saveApiKey(slotId, preset.id, rawKey);
            if (slotId === 'voice_tts') {
            await clearActiveShadowingAudioStore();
            clearGeminiLanguageFailures('gemini_tts');
          }
          }
          if (await loadApiKeyStrict(slotId, preset.id) !== rawKey.trim()) {
            throw new Error('The primary API key could not be verified after saving. Provider settings were not switched.');
          }
          keyStorageReadErrors.delete(`${slotId}|${preset.id}|primary`);
        }
        if (secondaryPreset) {
          const secondaryKeyInputValue = secondaryKeyInput?.value.trim() ?? '';
          const secondaryKey = secondaryKeyInputValue || await readKeyForSettings(slotId, secondaryPreset.id, 'secondary');
          if (!secondaryKey.trim()) throw new Error('Enter the API 2 key or choose a provider that already has a saved key.');
          if (secondaryKeyInputValue) {
            await saveApiKey(slotId, secondaryPreset.id, secondaryKey, 'secondary');
            if (slotId === 'voice_tts') {
            await clearActiveShadowingAudioStore();
            clearGeminiLanguageFailures('gemini_tts');
          }
          }
          if (await loadApiKeyStrict(slotId, secondaryPreset.id, 'secondary') !== secondaryKey.trim()) {
            throw new Error('The secondary API key could not be verified after saving. Provider settings were not switched.');
          }
          keyStorageReadErrors.delete(`${slotId}|${secondaryPreset.id}|secondary`);
        }

        // A secondary-only edit must not clear the verified primary connection.
        if (primaryChanged) await saveSlotConfig(cfg);
        else await saveSecondarySlotConfig(slotId, cfg.secondary);
        clearPreloadedSentenceAudio();
        if (slotId === 'voice_tts') {
            await clearActiveShadowingAudioStore();
            clearGeminiLanguageFailures('gemini_tts');
          }

        // Only remove an old secondary credential after the new config is saved.
        if (previousSecondary?.providerId &&
            (!secondaryPreset || previousSecondary.providerId !== secondaryPreset.id)) {
          await saveApiKey(slotId, previousSecondary.providerId, '', 'secondary');
        }

        configs[slotId] = cfg;
        keysBySlot[slotId] = rawKey;
        if (keyInput) {
          keyInput.value = '';
          keyInput.placeholder = rawKey ? 'Key saved securely. Leave blank to keep it, or type a replacement.' : 'Enter your API key...';
        }
        if (secondaryPreset) {
          secondaryKeysBySlot[slotId] = (secondaryKeyInput?.value.trim() || await readKeyForSettings(slotId, secondaryPreset.id, 'secondary'));
          if (secondaryKeyInput) {
            secondaryKeyInput.value = '';
            secondaryKeyInput.placeholder = secondaryKeysBySlot[slotId]
              ? 'API 2 key saved securely. Leave blank to keep it, or type a replacement.'
              : 'Enter second API key';
          }
        }
        else secondaryKeysBySlot[slotId] = '';
        refreshRequiredApiStatus();
        return { cfg, key: rawKey, primaryChanged };
      } catch (error) {
        const rollbackErrors: string[] = [];
        try {
          const allConfigs = await loadAllSlotsConfig();
          allConfigs[slotId] = previousConfig;
          await saveAllSlotsConfig(allConfigs);
          configs[slotId] = previousConfig;
        } catch (rollbackError) {
          rollbackErrors.push(`provider settings: ${String(rollbackError)}`);
        }
        for (const snapshot of keySnapshots.values()) {
          try {
            await saveApiKey(slotId, snapshot.providerId, snapshot.value, snapshot.account);
            if (await loadApiKeyStrict(slotId, snapshot.providerId, snapshot.account) !== snapshot.value.trim()) {
              throw new Error('read-back mismatch');
            }
          } catch (rollbackError) {
            rollbackErrors.push(`API key (${snapshot.account}): ${String(rollbackError)}`);
          }
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not save this provider configuration: ${detail}${rollbackErrors.length ? `. Rollback needs attention: ${rollbackErrors.join('; ')}` : '. Previous settings and API keys were restored.'}`);
      }
    };

    persistSlotDrafts[slotId] = async () => {
      await persistCurrentSlot();
    };

    secondaryTestBtn?.addEventListener('click', async () => {
      if (!secondaryTestBtn || !secondaryStatus) return;
      settingsProviderTestRunning = true;
      if (testAllApisButton) testAllApisButton.disabled = true;
      const providerId = secondaryProviderSelect?.value ?? '';
      if (!providerId) { secondaryStatus.textContent = 'API 2: Choose a provider first.'; settingsProviderTestRunning = false; if (testAllApisButton) testAllApisButton.disabled = !hasConfiguredOnlineAccount; return; }
      const secondaryPreset = getPreset(slotId, providerId);
      const secondaryCfg: SlotConfig = {
        slotId, providerId: secondaryPreset.id,
        baseUrl: secondaryBaseUrlInput?.value.trim() || secondaryPreset.defaultBaseUrl,
        modelOrVoice: secondaryModelInput?.value.trim() || secondaryPreset.defaultModelOrVoice,
        authStyle: (secondaryAuthSelect?.value as AuthStyle) || 'bearer',
        customHeaderName: secondaryHeaderInput?.value.trim() || undefined,
        customQueryParamName: secondaryQueryInput?.value.trim() || undefined,
        endpointPathOverride: secondaryEndpointInput?.value.trim() || undefined,
        customTtsVoice: secondaryCustomVoiceInput?.value.trim() || undefined
      };
      const apiKey = secondaryKeyInput?.value.trim() || await readKeyForSettings(slotId, secondaryPreset.id, 'secondary');
      secondaryTestBtn.disabled = true;
      secondaryStatus.className = 'status-box info';
      secondaryStatus.textContent = 'API 2: Testing…';
      try {
        const result = await testAndPersistSlotAccount(secondaryCfg, { apiKeyOverride: apiKey, account: 'secondary' });
        const testResult = {
          ok: result.ok && result.tier !== 3,
          latencyMs: result.latencyMs,
          message: result.message,
          testedAt: Date.now(),
          verificationFingerprint: result.verificationFingerprint
        };
        if (testResult.ok) {
          await saveApiKey(slotId, secondaryPreset.id, apiKey, 'secondary');
          if (slotId === 'voice_tts') {
            await clearActiveShadowingAudioStore();
            clearGeminiLanguageFailures('gemini_tts');
          }
          secondaryKeysBySlot[slotId] = apiKey;
          if (secondaryKeyInput) {
            secondaryKeyInput.value = '';
            secondaryKeyInput.placeholder = 'API 2 key saved securely. Leave blank to keep it, or type a replacement.';
          }
        }
        const verifiedConfig = { ...secondaryCfg, verified: testResult.ok, testResult };
        clearPreloadedSentenceAudio();
        if (slotId === 'voice_tts') {
            await clearActiveShadowingAudioStore();
            clearGeminiLanguageFailures('gemini_tts');
          }
        configs[slotId].secondary = verifiedConfig;
        secondaryStatus.className = `status-box ${testResult.ok ? 'pass' : 'fail'}`;
        secondaryStatus.textContent = `API 2: ${result.ok && result.tier !== 3 ? 'PASS' : 'FAIL'} — ${result.message}`;
        if (slotBadge) {
          const primaryTest = lastTestResults.get(slotId);
          const currentPrimaryTest = primaryTest?.providerId === configs[slotId].providerId ? primaryTest : undefined;
          const onlineVerified = isOnlineProviderVerified(currentPrimaryTest, verifiedConfig);
          slotBadge.className = `tier-badge ${onlineVerified ? 'online' : 'offline'}`;
          slotBadge.innerHTML = `<span class="tier-dot"></span>${onlineVerified ? 'Online AI' : 'Basic offline'}`;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const testResult = { ok: false, latencyMs: 0, message, testedAt: Date.now() };
        try {
          const failedConfig = { ...secondaryCfg, verified: false, testResult };
          await saveSecondarySlotConfig(slotId, failedConfig);
clearPreloadedSentenceAudio();
          configs[slotId].secondary = failedConfig;
        } catch { /* Keep the visible test error even if storage is unavailable. */ }
        secondaryStatus.className = 'status-box fail';
        secondaryStatus.textContent = `API 2: FAIL — ${message}`;
        if (slotBadge) {
          const primaryTest = lastTestResults.get(slotId);
          const currentPrimaryTest = primaryTest?.providerId === configs[slotId].providerId ? primaryTest : undefined;
          const onlineVerified = isOnlineProviderVerified(currentPrimaryTest, configs[slotId].secondary);
          slotBadge.className = `tier-badge ${onlineVerified ? 'online' : 'offline'}`;
          slotBadge.innerHTML = `<span class="tier-dot"></span>${onlineVerified ? 'Online AI' : 'Basic offline'}`;
        }
      } finally { secondaryTestBtn.disabled = false; settingsProviderTestRunning = false; if (testAllApisButton) testAllApisButton.disabled = !hasConfiguredOnlineAccount; refreshRequiredApiStatus(); }
    });

    saveBtn?.addEventListener('click', async () => {
      if (!saveBtn) return;
      saveBtn.disabled = true;
      try {
        const { cfg, primaryChanged } = await persistCurrentSlot();
        if (primaryChanged) {
          lastTestResults.delete(slotId);
          await clearSlotConnectionTestResult(slotId);
          markSlotNotVerified(`Saved ${getPreset(slotId, cfg.providerId).name}. Run Test API 1 to verify the connection.`);
        }
        // The slot badge represents the whole slot, not API 1 alone. A verified
        // API 2 must keep it online even when API 1's last test failed.
        if (slotBadge) {
          const primaryTest = lastTestResults.get(slotId);
          const currentPrimaryTest = primaryTest?.providerId === cfg.providerId ? primaryTest : undefined;
          const onlineVerified = isOnlineProviderVerified(currentPrimaryTest, cfg.secondary);
          slotBadge.className = `tier-badge ${onlineVerified ? 'online' : 'offline'}`;
          slotBadge.innerHTML = `<span class="tier-dot"></span>${onlineVerified ? 'Online AI' : 'Basic offline'}`;
        }
        if (saveStatus) {
          saveStatus.hidden = false;
          saveStatus.className = `status-box ${primaryChanged ? 'info' : 'pass'} settings-save-status`;
          saveStatus.textContent = primaryChanged
            ? 'Settings saved. API 1 needs a new connection test; API 2 settings were saved separately.'
            : 'Settings saved. API 1 and its verification state were kept unchanged; API 2 settings were saved.';
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (saveStatus) {
          saveStatus.hidden = false;
          saveStatus.className = 'status-box fail settings-save-status';
          saveStatus.textContent = `Save failed — ${message}`;
        } else if (statusBox) {
          statusBox.className = 'status-box fail';
          statusBox.textContent = `Save failed — ${message}`;
        }
      } finally {
        saveBtn.disabled = false;
      }
    });

    ignoreVerificationErrorBtn?.addEventListener('click', () => {
      dismissedVerificationErrors.add(slotId);
      if (statusBox) statusBox.style.display = 'none';
      if (verificationActions) verificationActions.style.display = 'none';
    });

    testBtn?.addEventListener('click', async () => {
      if (!testBtn || !statusBox) return;
      settingsProviderTestRunning = true;
      if (testAllApisButton) testAllApisButton.disabled = true;
      testBtn.disabled = true;
      statusBox.className = 'status-box info';
      dismissedVerificationErrors.delete(slotId);
      if (verificationActions) verificationActions.style.display = 'none';
      statusBox.style.display = '';
      if (saveStatus) saveStatus.hidden = true;
      statusBox.textContent = 'API 1: Testing…';
      try {
        const { cfg, key } = await persistCurrentSlot();
        const result = await testAndPersistSlotAccount(cfg, { apiKeyOverride: key, account: 'primary' });
        const persistedResult = await loadSlotConnectionTestResult(slotId);
        lastTestResults.set(slotId, persistedResult ?? result);
        dismissedVerificationErrors.delete(slotId);
        if (verificationActions) verificationActions.style.display = result.ok ? 'none' : 'flex';
        if (slotBadge) {
          const onlineVerified = isOnlineProviderVerified(
            result.providerId === configs[slotId].providerId ? result : undefined,
            configs[slotId].secondary
          );
          slotBadge.className = `tier-badge ${onlineVerified ? 'online' : 'offline'}`;
          slotBadge.innerHTML = `<span class="tier-dot"></span>${onlineVerified ? 'Online AI' : 'Basic offline'}`;
        }
        statusBox.className = `status-box ${result.ok && result.tier !== 3 ? 'pass' : 'fail'}`;
        statusBox.textContent = `API 1: ${result.ok && result.tier !== 3 ? 'PASS' : 'FAIL'} — ${result.message}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        statusBox.className = 'status-box fail';
        statusBox.textContent = `API 1: FAIL — ${message}`;
      } finally {
        testBtn.disabled = false;
        settingsProviderTestRunning = false;
        if (testAllApisButton) testAllApisButton.disabled = !hasConfiguredOnlineAccount;
      }
    });
  }
}
