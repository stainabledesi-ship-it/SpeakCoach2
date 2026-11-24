import { Preferences } from '@capacitor/preferences';
import type { SlotConfig, SlotId } from '../config/types';

export type ProviderAccount = 'primary' | 'secondary';
export type ProviderHealthState = 'needs-retest' | 'cooldown';

export interface ProviderAccountHealth {
  state: ProviderHealthState;
  reason: string;
  status?: number;
  updatedAt: number;
  cooldownUntil?: number;
}

const STORAGE_KEY = 'speakcoach.provider_account_health.v1';
const health = new Map<string, ProviderAccountHealth>();
let hydration: Promise<void> | null = null;

function key(slotId: SlotId, account: ProviderAccount): string {
  return `${slotId}:${account}`;
}

async function hydrate(): Promise<void> {
  if (!hydration) {
    hydration = (async () => {
      let raw: string | null = null;
      try {
        raw = (await Preferences.get({ key: STORAGE_KEY })).value;
      } catch {
        // Fall back to Web Storage below.
      }
      if (!raw) {
        try {
          raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
        } catch {
          // Health is advisory. An unavailable store must not block app startup.
        }
      }
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as Record<string, ProviderAccountHealth>;
        for (const [entryKey, entry] of Object.entries(parsed)) {
          if (entry && (entry.state === 'needs-retest' || entry.state === 'cooldown')) {
            health.set(entryKey, entry);
          }
        }
      } catch {
        // A damaged health snapshot is ignored; the next failure will recreate it.
      }
    })();
  }
  await hydration;
}

async function persist(): Promise<void> {
  const serialized = JSON.stringify(Object.fromEntries(health));
  try {
    await Preferences.set({ key: STORAGE_KEY, value: serialized });
  } catch {
    // Fall back to Web Storage below when the native preferences bridge is unavailable.
  }
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // Runtime health must never break synthesis or settings saves if storage is full.
  }
}

function getStatus(error: unknown): { status?: number; retryAfterMs?: number; reason: string; networkFailure: boolean } {
  const candidate = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = typeof candidate.status === 'number' ? candidate.status : undefined;
  const retryAfterMs = typeof candidate.retryAfterMs === 'number' ? candidate.retryAfterMs : undefined;
  const rawReason = error instanceof Error ? error.message : String(error);
  const networkFailure = /timeout|timed out|network/i.test(rawReason);
  // Persist only a safe classification, never raw provider messages or request URLs
  // that may contain API keys (for example, Gemini's key query parameter).
  const reason = status === 401 || status === 403
    ? 'API key is invalid, revoked, or not authorized for this model.'
    : status === 404
      ? 'Model or endpoint was not found; check the saved model and endpoint.'
      : status === 400
        ? 'Provider rejected the request; check model, voice, and request settings.'
        : status === 429
          ? 'Provider quota or rate limit was reached.'
          : status !== undefined && status >= 500
            ? 'Provider service is temporarily unavailable.'
            : status === 408 || networkFailure
              ? 'Network request timed out or the connection failed.'
              : 'Provider request failed.';
  return { status, retryAfterMs, reason, networkFailure };
}

export async function getProviderAccountHealth(
  slotId: SlotId,
  account: ProviderAccount,
  now = Date.now()
): Promise<ProviderAccountHealth | null> {
  await hydrate();
  const entryKey = key(slotId, account);
  const entry = health.get(entryKey);
  if (!entry) return null;
  if (entry.state === 'cooldown' && (entry.cooldownUntil ?? 0) <= now) {
    health.delete(entryKey);
    await persist();
    return null;
  }
  return entry;
}

export async function markProviderAccountFailure(
  slotId: SlotId,
  account: ProviderAccount,
  error: unknown,
  now = Date.now()
): Promise<void> {
  await hydrate();
  const { status, retryAfterMs, reason, networkFailure } = getStatus(error);
  if ([401, 403, 404].includes(status ?? -1)) {
    health.set(key(slotId, account), { state: 'needs-retest', reason, status, updatedAt: now });
    await persist();
    return;
  }
  // HTTP 400 is request-specific (voice/text/model parameters can vary); cool down briefly rather than requiring a manual re-test.
  if (status === 400 || status === 408 || status === 429 || (status !== undefined && status >= 500) || status === 0 || networkFailure) {
    const duration = Math.max(1000, Math.min(10 * 60 * 1000, retryAfterMs ?? (status === 400 ? 60_000 : 90_000)));
    health.set(key(slotId, account), {
      state: 'cooldown', reason, status, updatedAt: now, cooldownUntil: now + duration
    });
    await persist();
  }
}

export async function clearProviderAccountHealth(
  slotId: SlotId,
  account?: ProviderAccount
): Promise<void> {
  await hydrate();
  if (account) health.delete(key(slotId, account));
  else {
    health.delete(key(slotId, 'primary'));
    health.delete(key(slotId, 'secondary'));
  }
  await persist();
}

export async function clearAllProviderAccountHealth(): Promise<void> {
  await hydrate();
  health.clear();
  await persist();
}

/** Bind a successful connection test to the exact provider configuration and a SHA-256 key digest. */
export async function createProviderVerificationFingerprint(
  config: SlotConfig,
  apiKey: string
): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const canonical = [
      config.providerId,
      config.baseUrl.trim().replace(/\/+$/, ''),
      config.modelOrVoice.trim(),
      config.customTtsVoice?.trim() ?? '',
      apiKey
    ].join('|');
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return Array.from(new Uint8Array(digest).slice(0, 16))
      .map(value => value.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}
