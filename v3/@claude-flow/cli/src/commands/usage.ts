/**
 * V3 CLI `usage` command.
 *
 * Surfaces Claude's "Plan usage limits" (current 5-hour session + weekly windows)
 * in the terminal — the same data Claude Code's `/usage` shows. Reuses Claude
 * Code's existing OAuth login (no separate sign-in) and caches results to respect
 * the upstream endpoint's aggressive rate-limiting.
 *
 * @module @claude-flow/cli/commands/usage
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { resolveClaudeOAuthToken, isTokenExpired } from '../usage/credentials.js';
import { getUsage, UsageError } from '../usage/client.js';
import type { UsageData, UsageResult, UsageWindow } from '../usage/client.js';

// ============================================================================
// Pure rendering helpers (exported for tests)
// ============================================================================

/** Render a colored utilization bar, e.g. `[█████░░░░░░░░░░░░░░░]`. */
export function renderBar(pct: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled);
  const rest = '░'.repeat(empty);
  let colored: string;
  if (clamped >= 75) colored = output.error(bar);
  else if (clamped >= 50) colored = output.warning(bar);
  else colored = output.success(bar);
  return `[${colored}${output.dim(rest)}]`;
}

/** Human "resets in 4h 28m" string for a future ISO timestamp. */
export function formatResetIn(resetIso: string, now: number = Date.now()): string {
  const t = new Date(resetIso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = t - now;
  if (diff <= 0) return 'resets now';
  const totalMin = Math.floor(diff / 60_000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `resets in ${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `resets in ${hours}h ${mins}m`;
  return `resets in ${mins}m`;
}

/** Human "1m ago" / "just now" string for a past epoch timestamp. */
export function formatAgo(fetchedAt: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - fetchedAt);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  return `${hours}h ${min % 60}m ago`;
}

/** Render one window row, or null when the window is absent. */
export function renderRow(
  label: string,
  win: UsageWindow | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!win || typeof win.utilization !== 'number') return null;
  const pct = Math.round(win.utilization);
  const bar = renderBar(pct);
  const reset = win.resets_at ? ` ${output.dim('· ' + formatResetIn(win.resets_at, now))}` : '';
  return `${label.padEnd(16)}${bar} ${pct}% used${reset}`;
}

/** Build the full panel as an array of lines (no I/O — testable). */
export function buildPanelLines(result: UsageResult, now: number = Date.now()): string[] {
  const d: UsageData = result.data;
  const lines: string[] = [];
  lines.push(output.bold('Plan usage limits'));
  lines.push('');

  const rows: Array<[string, UsageWindow | null | undefined]> = [
    ['Current session', d.five_hour],
    ['Weekly (all)', d.seven_day],
    ['Weekly (Sonnet)', d.seven_day_sonnet],
    ['Weekly (Opus)', d.seven_day_opus],
  ];

  let any = false;
  for (const [label, win] of rows) {
    const line = renderRow(label, win, now);
    if (line) {
      lines.push('  ' + line);
      any = true;
    }
  }

  const extra = d.extra_usage;
  if (extra && extra.is_enabled && typeof extra.utilization === 'number') {
    const row = renderRow('Extra credits', { utilization: extra.utilization, resets_at: '' }, now);
    if (row) {
      lines.push('  ' + row);
      any = true;
    }
  }

  if (!any) {
    lines.push(
      output.dim('No usage windows reported yet — data appears after your first Claude request in a session.'),
    );
  }

  lines.push('');
  const staleNote = result.stale
    ? ' (cached — live refresh failed)'
    : result.source === 'cache'
      ? ' (cached)'
      : '';
  lines.push(output.dim(`Updated ${formatAgo(result.fetchedAt, now)}${staleNote}`));
  return lines;
}

// ============================================================================
// Version resolution (local; avoids importing the CLI entrypoint)
// ============================================================================

let cachedVersion: string | null = null;
/** Resolve the CLI's package version (for the User-Agent), cached after first read. */
function resolveCliVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // dist/src/commands
    // Try a couple of likely package.json locations relative to the build layout.
    for (const rel of [['..', '..', '..'], ['..', '..']]) {
      const pkgPath = join(here, ...rel, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string };
        if (pkg.version) {
          cachedVersion = pkg.version;
          return cachedVersion;
        }
      }
    }
  } catch {
    // Fall through to default.
  }
  cachedVersion = '0.0.0';
  return cachedVersion;
}

// ============================================================================
// Command action
// ============================================================================

/**
 * `usage` command action: resolve the Claude token, fetch (or read cached)
 * usage, and print either a formatted panel or JSON. Maps failures to
 * user-facing messages and a non-zero exit code.
 */
async function runUsage(ctx: CommandContext): Promise<CommandResult> {
  const asJson = ctx.flags.json === true || ctx.flags.format === 'json';
  const refresh = ctx.flags.refresh === true;
  const now = Date.now();

  const resolved = await resolveClaudeOAuthToken();
  if (!resolved) {
    if (asJson) {
      output.printJson({ error: 'not_authenticated' });
    } else {
      output.writeln();
      output.printWarning('Not logged in to Claude Code.');
      output.writeln(output.dim('Run `claude` to log in, then re-run `claude-flow usage`.'));
    }
    return { success: false, exitCode: 1 };
  }

  if (isTokenExpired(resolved, now)) {
    if (asJson) {
      output.printJson({ error: 'token_expired' });
    } else {
      output.writeln();
      output.printWarning('Your Claude Code session token has expired.');
      output.writeln(output.dim('Open Claude Code (`claude`) to refresh it, then re-run `claude-flow usage`.'));
    }
    return { success: false, exitCode: 1 };
  }

  let result: UsageResult;
  try {
    result = await getUsage({
      token: resolved.token,
      version: resolveCliVersion(),
      cwd: ctx.cwd,
      refresh,
      now,
    });
  } catch (err) {
    const e = err as UsageError;
    if (asJson) {
      output.printJson({ error: e.code ?? 'error', message: e.message });
      return { success: false, exitCode: 1 };
    }
    output.writeln();
    if (e.code === 'unauthenticated') {
      output.printError('Claude rejected the stored token.', 'Re-authenticate in Claude Code (`claude`).');
    } else if (e.code === 'rate_limited') {
      output.printWarning('Claude usage endpoint is rate-limited and no cached data is available.');
      output.writeln(output.dim('Wait a few minutes and try again.'));
    } else {
      output.printError('Could not retrieve usage data.', e.message);
    }
    return { success: false, exitCode: 1 };
  }

  if (asJson) {
    output.printJson({
      ...result.data,
      _meta: { fetchedAt: result.fetchedAt, stale: result.stale, source: result.source },
    });
    return { success: true, data: result.data };
  }

  output.writeln();
  for (const line of buildPanelLines(result, now)) {
    output.writeln(line);
  }
  return { success: true, data: result.data };
}

export const usageCommand: Command = {
  name: 'usage',
  description: 'Show your Claude plan usage (current session + weekly limits)',
  options: [
    { name: 'json', description: 'Output raw usage data as JSON', type: 'boolean', default: false },
    { name: 'refresh', short: 'r', description: 'Bypass the cache and fetch live data', type: 'boolean', default: false },
  ],
  examples: [
    { command: 'claude-flow usage', description: 'Show current session and weekly usage' },
    { command: 'claude-flow usage --refresh', description: 'Force a live refresh (min ~180s between calls)' },
    { command: 'claude-flow usage --json', description: 'Print raw usage data as JSON' },
  ],
  action: runUsage,
};

export default usageCommand;
