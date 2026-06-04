/**
 * Tests for the `usage` command stack:
 *   - usage/credentials.ts — Claude Code OAuth token resolution
 *   - usage/client.ts       — fetch + cache + error mapping
 *   - commands/usage.ts      — pure render helpers
 *
 * Network is never hit: a fake `fetchImpl` is injected. Filesystem state uses a
 * throwaway temp dir so the real ~/.claude and project caches are untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  resolveClaudeOAuthToken,
  isTokenExpired,
  credentialsFilePath,
} from '../src/usage/credentials.js';
import {
  getUsage,
  fetchClaudeUsage,
  UsageError,
  type UsageData,
} from '../src/usage/client.js';
import {
  usageCommand,
  buildPanelLines,
  renderRow,
  formatResetIn,
  formatAgo,
} from '../src/commands/usage.js';

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[0-9;]*m/g, '');

const SAMPLE: UsageData = {
  five_hour: { utilization: 21, resets_at: '2099-01-01T00:00:00.000Z' },
  seven_day: { utilization: 26, resets_at: '2099-01-04T17:29:00.000Z' },
  seven_day_sonnet: { utilization: 15, resets_at: '2099-01-04T17:29:00.000Z' },
  seven_day_opus: null,
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
};

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response) as unknown as typeof fetch;
}

let workdir: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'ruflo-usage-'));
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CONFIG_DIR = join(workdir, 'claude-cfg');
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  // Restore env by mutating the existing process.env object (not replacing it):
  // delete keys added during the test, then re-apply the snapshot.
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

// ---------------------------------------------------------------------------
// credentials.ts
// ---------------------------------------------------------------------------

describe('resolveClaudeOAuthToken', () => {
  it('prefers the CLAUDE_CODE_OAUTH_TOKEN env override', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-token-123';
    const resolved = await resolveClaudeOAuthToken();
    expect(resolved).toEqual({ token: 'env-token-123', source: 'env' });
  });

  it('reads the credentials file under CLAUDE_CONFIG_DIR', async () => {
    const path = credentialsFilePath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ claudeAiOauth: { accessToken: 'file-token', expiresAt: 123 } }),
      'utf-8',
    );
    const resolved = await resolveClaudeOAuthToken();
    expect(resolved?.token).toBe('file-token');
    expect(resolved?.source).toBe('file');
    expect(resolved?.expiresAt).toBe(123);
  });

  it('returns null when no credentials exist (not logged in)', async () => {
    // On macOS the Keychain could still hold a real token; skip there to stay hermetic.
    if (process.platform === 'darwin') return;
    const resolved = await resolveClaudeOAuthToken();
    expect(resolved).toBeNull();
  });

  it('isTokenExpired honors the recorded expiry', () => {
    expect(isTokenExpired({ token: 't', source: 'file', expiresAt: 1000 }, 2000)).toBe(true);
    expect(isTokenExpired({ token: 't', source: 'file', expiresAt: 5000 }, 2000)).toBe(false);
    expect(isTokenExpired({ token: 't', source: 'env' }, 2000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// client.ts
// ---------------------------------------------------------------------------

describe('fetchClaudeUsage', () => {
  it('returns parsed data on 200', async () => {
    const data = await fetchClaudeUsage('tok', { version: '1.2.3', fetchImpl: fakeFetch(200, SAMPLE) });
    expect(data.five_hour?.utilization).toBe(21);
  });

  it('maps 401 to an unauthenticated UsageError', async () => {
    await expect(
      fetchClaudeUsage('tok', { version: '1', fetchImpl: fakeFetch(401, {}) }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('maps 429 to a rate_limited UsageError', async () => {
    await expect(
      fetchClaudeUsage('tok', { version: '1', fetchImpl: fakeFetch(429, {}) }),
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      fetchClaudeUsage('tok', { version: '1', fetchImpl: fakeFetch(429, {}) }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('getUsage caching', () => {
  it('fetches live, writes cache, and does NOT persist the token', async () => {
    const res = await getUsage({
      token: 'secret-token-should-not-leak',
      version: '1',
      cwd: workdir,
      fetchImpl: fakeFetch(200, SAMPLE),
      now: 1_000_000,
    });
    expect(res.source).toBe('live');
    expect(res.stale).toBe(false);

    const cacheFile = join(workdir, '.claude-flow', 'usage', 'cache.json');
    expect(existsSync(cacheFile)).toBe(true);
    const raw = readFileSync(cacheFile, 'utf-8');
    expect(raw).not.toContain('secret-token-should-not-leak');
    expect(JSON.parse(raw).data.five_hour.utilization).toBe(21);
  });

  it('serves fresh cache without calling fetch', async () => {
    const exploding: typeof fetch = (async () => {
      throw new Error('fetch should not be called');
    }) as unknown as typeof fetch;

    // Seed the cache via a first live call.
    await getUsage({ token: 't', version: '1', cwd: workdir, fetchImpl: fakeFetch(200, SAMPLE), now: 1_000_000 });
    // Second call within TTL must hit the cache only.
    const res = await getUsage({ token: 't', version: '1', cwd: workdir, fetchImpl: exploding, now: 1_000_000 + 5_000 });
    expect(res.source).toBe('cache');
    expect(res.stale).toBe(false);
  });

  it('falls back to stale cache when a refresh hits 429', async () => {
    await getUsage({ token: 't', version: '1', cwd: workdir, fetchImpl: fakeFetch(200, SAMPLE), now: 1_000_000 });
    const res = await getUsage({
      token: 't',
      version: '1',
      cwd: workdir,
      refresh: true,
      fetchImpl: fakeFetch(429, {}),
      now: 1_000_000 + 5_000,
    });
    expect(res.source).toBe('cache');
    expect(res.stale).toBe(true);
    expect(res.data.five_hour?.utilization).toBe(21);
  });

  it('rethrows when refresh fails and no cache exists', async () => {
    await expect(
      getUsage({ token: 't', version: '1', cwd: workdir, fetchImpl: fakeFetch(429, {}), now: 1 }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('rethrows unauthenticated errors instead of masking them with stale cache', async () => {
    // Seed a cache, then a refresh that 401s must NOT serve stale data —
    // a revoked/expired token has to surface so the caller can re-auth.
    await getUsage({ token: 't', version: '1', cwd: workdir, fetchImpl: fakeFetch(200, SAMPLE), now: 1_000_000 });
    await expect(
      getUsage({ token: 't', version: '1', cwd: workdir, refresh: true, fetchImpl: fakeFetch(401, {}), now: 1_000_000 + 5_000 }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

// ---------------------------------------------------------------------------
// commands/usage.ts — runUsage action wiring
// ---------------------------------------------------------------------------

describe('usageCommand action', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = (flags: Record<string, unknown> = {}): any =>
    ({ args: [], flags, cwd: workdir, interactive: false });

  function seedFreshCache() {
    mkdirSync(join(workdir, '.claude-flow', 'usage'), { recursive: true });
    writeFileSync(
      join(workdir, '.claude-flow', 'usage', 'cache.json'),
      JSON.stringify({ fetchedAt: Date.now(), data: SAMPLE }),
      'utf-8',
    );
  }

  it('returns exitCode 1 with a friendly result when not logged in', async () => {
    if (process.platform === 'darwin') return; // Keychain may hold a real token
    const res = await usageCommand.action!(ctx());
    expect(res).toMatchObject({ success: false, exitCode: 1 });
  });

  it('returns exitCode 1 when the resolved token is expired', async () => {
    if (process.platform === 'darwin') return; // Keychain precedes the file on macOS
    const path = credentialsFilePath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: 1 } }), 'utf-8');
    const res = await usageCommand.action!(ctx());
    expect(res).toMatchObject({ success: false, exitCode: 1 });
  });

  it('renders from fresh cache when authenticated — no network', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'valid-env-token';
    seedFreshCache();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await usageCommand.action!(ctx())) as any;
    expect(res.success).toBe(true);
    expect((res.data as UsageData).five_hour?.utilization).toBe(21);
  });

  it('succeeds with --json (served from cache)', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'valid-env-token';
    seedFreshCache();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await usageCommand.action!(ctx({ json: true }))) as any;
    expect(res.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// commands/usage.ts render helpers
// ---------------------------------------------------------------------------

describe('render helpers', () => {
  const NOW = Date.parse('2099-01-01T00:00:00.000Z');

  it('renderRow shows percentage and reset, null for missing window', () => {
    const row = renderRow('Current session', { utilization: 21, resets_at: '2099-01-01T04:28:00.000Z' }, NOW);
    expect(stripAnsi(row ?? '')).toContain('21% used');
    expect(stripAnsi(row ?? '')).toContain('resets in 4h 28m');
    expect(renderRow('Weekly (Opus)', null, NOW)).toBeNull();
  });

  it('formatResetIn handles minutes, hours, days, and past', () => {
    expect(formatResetIn('2099-01-01T00:30:00.000Z', NOW)).toBe('resets in 30m');
    expect(formatResetIn('2099-01-01T02:05:00.000Z', NOW)).toBe('resets in 2h 5m');
    expect(formatResetIn('2099-01-03T02:00:00.000Z', NOW)).toBe('resets in 2d 2h');
    expect(formatResetIn('2098-12-31T00:00:00.000Z', NOW)).toBe('resets now');
  });

  it('formatAgo summarizes elapsed time', () => {
    expect(formatAgo(NOW, NOW)).toBe('just now');
    expect(formatAgo(NOW - 5 * 60_000, NOW)).toBe('5m ago');
  });

  it('buildPanelLines renders all present windows and the freshness footer', () => {
    const text = stripAnsi(
      buildPanelLines({ data: SAMPLE, fetchedAt: NOW - 60_000, stale: false, source: 'live' }, NOW).join('\n'),
    );
    expect(text).toContain('Plan usage limits');
    expect(text).toContain('Current session');
    expect(text).toContain('21% used');
    expect(text).toContain('Weekly (all)');
    expect(text).toContain('26% used');
    expect(text).toContain('Weekly (Sonnet)');
    expect(text).toContain('15% used');
    expect(text).not.toContain('Weekly (Opus)'); // null window omitted
    expect(text).toContain('Updated 1m ago');
  });

  it('buildPanelLines marks stale cache in the footer', () => {
    const text = stripAnsi(
      buildPanelLines({ data: SAMPLE, fetchedAt: NOW, stale: true, source: 'cache' }, NOW).join('\n'),
    );
    expect(text).toContain('cached — live refresh failed');
  });
});
