import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllProviderAccountHealth,
  getProviderAccountHealth,
  clearProviderAccountHealth,
  markProviderAccountFailure
} from '../src/services/providerHealth';

describe('per-account provider runtime health', () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearAllProviderAccountHealth();
  });

  it.each([401, 404])('marks HTTP %i as needing a connection re-test', async status => {
    await markProviderAccountFailure('voice_tts', 'primary', Object.assign(new Error(`HTTP ${status}`), { status }));
    const health = await getProviderAccountHealth('voice_tts', 'primary');
    expect(health?.state).toBe('needs-retest');
    expect(health?.status).toBe(status);
  });

  it('places HTTP 400 into a short cooldown rather than requiring a manual re-test', async () => {
    const now = 1_000_000;
    await markProviderAccountFailure('voice_tts', 'primary', Object.assign(new Error('HTTP 400'), { status: 400 }), now);
    const entry = await getProviderAccountHealth('voice_tts', 'primary', now + 10_000);
    expect(entry?.state).toBe('cooldown');
    expect(entry?.cooldownUntil).toBe(now + 60_000);
  });

  it('keeps primary and secondary account health independent', async () => {
    await markProviderAccountFailure('voice_tts', 'primary', Object.assign(new Error('HTTP 401'), { status: 401 }));
    expect(await getProviderAccountHealth('voice_tts', 'primary')).not.toBeNull();
    expect(await getProviderAccountHealth('voice_tts', 'secondary')).toBeNull();
  });

  it('applies a bounded cooldown for HTTP 429 and respects Retry-After', async () => {
    const now = 1_000_000;
    await markProviderAccountFailure(
      'voice_tts',
      'primary',
      Object.assign(new Error('HTTP 429'), { status: 429, retryAfterMs: 120_000 }),
      now
    );
    const active = await getProviderAccountHealth('voice_tts', 'primary', now + 60_000);
    expect(active?.state).toBe('cooldown');
    expect(active?.cooldownUntil).toBe(now + 120_000);
    expect(await getProviderAccountHealth('voice_tts', 'primary', now + 120_001)).toBeNull();
  });
  it('persists needs-retest state and clears it after a successful account test', async () => {
    await markProviderAccountFailure('voice_tts', 'primary', Object.assign(new Error('Request URL contained ?key=must-not-persist'), { status: 404 }));
    const persisted = localStorage.getItem('speakcoach.provider_account_health.v1') ?? '';
    expect(persisted).toContain('needs-retest');
    expect(persisted).not.toContain('must-not-persist');
    await clearProviderAccountHealth('voice_tts', 'primary');
    expect(await getProviderAccountHealth('voice_tts', 'primary')).toBeNull();
  });

});
