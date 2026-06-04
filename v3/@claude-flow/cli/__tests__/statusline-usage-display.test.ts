/**
 * Statusline plan-usage section.
 *
 * The statusline renders Claude's "Plan usage limits" (current 5-hour session +
 * weekly windows) as colored bars. Data source order:
 *   1. Claude Code's documented `rate_limits` stdin field (v2.1.80+) — live, no token
 *   2. fallback to the cache written by `ruflo usage` (.claude-flow/usage/cache.json)
 *
 * These tests cover the generator contract, the live stdin path, the cache
 * fallback, and the RUFLO_STATUSLINE_HIDE_USAGE toggle. PATH is neutered so the
 * script's npx/git probes fail instantly and fall back to local data, keeping the
 * run offline and deterministic.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { generateStatuslineScript } from '../src/init/statusline-generator.js';
import { DEFAULT_INIT_OPTIONS } from '../src/init/types.js';

const SCRIPT = generateStatuslineScript(DEFAULT_INIT_OPTIONS);

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[0-9;]*m/g, '');

const nowSec = () => Math.floor(Date.now() / 1000);

/** Run the generated statusline with a stdin payload; returns full ANSI-stripped output. */
function render(payload: unknown, env: Record<string, string> = {}, seedCache?: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ruflo-usage-sl-'));
  try {
    const scriptPath = path.join(dir, 'statusline.cjs');
    writeFileSync(scriptPath, SCRIPT, 'utf-8');
    if (seedCache !== undefined) {
      mkdirSync(path.join(dir, '.claude-flow', 'usage'), { recursive: true });
      writeFileSync(path.join(dir, '.claude-flow', 'usage', 'cache.json'), JSON.stringify(seedCache), 'utf-8');
    }
    const out = execFileSync(process.execPath, [scriptPath], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      cwd: dir, // isolated CWD: no stray cache, fast local fallback
      env: { PATH: '/nonexistent', HOME: dir, ...env },
      timeout: 15000,
    });
    return stripAnsi(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const base = {
  model: { display_name: 'Opus 4.8 (1M context)' },
  context_window: { used_percentage: 0 },
  cost: { total_cost_usd: 0, total_duration_ms: 0 },
};

describe('statusline usage — generator contract', () => {
  it('reads the rate_limits stdin field and exposes the hide toggle', () => {
    expect(SCRIPT).toContain('RUFLO_STATUSLINE_HIDE_USAGE');
    expect(SCRIPT).toContain('rate_limits');
    expect(SCRIPT).toContain('getUsageWindows');
    expect(SCRIPT).toContain('Current session');
    expect(SCRIPT).toContain("['five_hour', 'Current session']");
  });
});

describe('statusline usage — live (rate_limits from stdin)', () => {
  it('renders session + weekly bars with percentages and resets', () => {
    const out = render({
      ...base,
      rate_limits: {
        five_hour: { used_percentage: 33, resets_at: nowSec() + 7200 },
        seven_day: { used_percentage: 41, resets_at: nowSec() + 345600 },
      },
    });
    expect(out).toContain('Current session');
    expect(out).toContain('33% used');
    expect(out).toContain('Weekly (all)');
    expect(out).toContain('41% used');
    expect(out).toContain('resets in');
    expect(out).toContain('Updated just now');
    // Filled/empty bar glyphs present.
    expect(out).toContain('█');
    expect(out).toContain('░');
  });

  it('includes Sonnet/Opus windows when present', () => {
    const out = render({
      ...base,
      rate_limits: {
        five_hour: { used_percentage: 92, resets_at: nowSec() + 1800 },
        seven_day: { used_percentage: 78, resets_at: nowSec() + 172800 },
        seven_day_sonnet: { used_percentage: 55, resets_at: nowSec() + 172800 },
        seven_day_opus: { used_percentage: 40, resets_at: nowSec() + 172800 },
      },
    });
    expect(out).toContain('Weekly (Sonnet)');
    expect(out).toContain('55% used');
    expect(out).toContain('Weekly (Opus)');
    expect(out).toContain('40% used');
    expect(out).toContain('92% used');
  });
});

describe('statusline usage — cache fallback', () => {
  it('falls back to .claude-flow/usage/cache.json when stdin lacks rate_limits', () => {
    const out = render(
      base, // no rate_limits
      {},
      {
        fetchedAt: Date.now() - 3 * 60_000,
        data: {
          five_hour: { utilization: 33, resets_at: new Date(Date.now() + 7_200_000).toISOString() },
          seven_day: { utilization: 41, resets_at: new Date(Date.now() + 345_600_000).toISOString() },
        },
      },
    );
    expect(out).toContain('Current session');
    expect(out).toContain('33% used');
    expect(out).toContain('(cached)');
    expect(out).toContain('ago');
  });
});

describe('statusline usage — absent and hidden', () => {
  it('shows no usage section when neither stdin nor cache has data', () => {
    const out = render(base);
    expect(out).not.toContain('Current session');
    expect(out).not.toContain('Weekly (all)');
  });

  it('omits the section when RUFLO_STATUSLINE_HIDE_USAGE is set', () => {
    const out = render(
      {
        ...base,
        rate_limits: { five_hour: { used_percentage: 33, resets_at: nowSec() + 7200 } },
      },
      { RUFLO_STATUSLINE_HIDE_USAGE: '1' },
    );
    expect(out).not.toContain('Current session');
  });
});
