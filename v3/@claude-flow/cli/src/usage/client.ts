/**
 * Claude subscription usage client.
 *
 * Fetches the "Plan usage limits" data (current 5-hour session + weekly windows)
 * that Claude Code's `/usage` surfaces. There is no documented API for this; the
 * data comes from the undocumented OAuth endpoint below, which rate-limits
 * aggressively. We therefore cache results (default 180s) and, on any refresh
 * failure (network / 429), fall back to the last-good cached value flagged stale.
 *
 * SECURITY: only the usage response is cached — the OAuth token is never written
 * to disk here.
 *
 * @module @claude-flow/cli/usage/client
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
/** Endpoint rate-limits hard; do not poll faster than this. */
export const DEFAULT_TTL_MS = 180_000;

/** One usage window (e.g. the 5-hour session or a weekly limit). */
export interface UsageWindow {
  /** Percentage of the window consumed, 0-100. */
  utilization: number;
  /** ISO-8601 timestamp when this window resets. */
  resets_at: string;
}

/** The full "Plan usage limits" payload returned by the usage endpoint. */
export interface UsageData {
  /** "Current session" (rolling 5-hour window). */
  five_hour?: UsageWindow | null;
  /** Weekly limit across all models. */
  seven_day?: UsageWindow | null;
  /** Weekly limit for Sonnet only. */
  seven_day_sonnet?: UsageWindow | null;
  /** Weekly limit for Opus only (null when unused). */
  seven_day_opus?: UsageWindow | null;
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number | null;
    used_credits?: number | null;
    utilization?: number | null;
  } | null;
}

/** Classification of a usage-fetch failure, used to decide fallback behavior. */
export type UsageErrorCode = 'unauthenticated' | 'rate_limited' | 'network' | 'http';

/** Error thrown by the usage client, tagged with a {@link UsageErrorCode}. */
export class UsageError extends Error {
  constructor(message: string, public readonly code: UsageErrorCode) {
    super(message);
    this.name = 'UsageError';
  }
}

/** A usage lookup result plus freshness metadata (live vs cached). */
export interface UsageResult {
  data: UsageData;
  /** Epoch ms the data was fetched. */
  fetchedAt: number;
  /** True when served from cache after a failed/skipped live refresh. */
  stale: boolean;
  source: 'live' | 'cache';
}

interface CacheFile {
  fetchedAt: number;
  data: UsageData;
}

/** Directory that holds the usage cache for a given working directory. */
function cacheDir(cwd: string): string {
  return join(cwd, '.claude-flow', 'usage');
}

/** Absolute path to the usage cache file. */
function cachePath(cwd: string): string {
  return join(cacheDir(cwd), 'cache.json');
}

/** Read and validate the cache file, returning null when missing or corrupt. */
function readCache(cwd: string): CacheFile | null {
  const p = cachePath(cwd);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as CacheFile;
    if (typeof parsed.fetchedAt === 'number' && parsed.data && typeof parsed.data === 'object') {
      return parsed;
    }
  } catch {
    // Corrupt cache — treat as absent.
  }
  return null;
}

/** Persist the usage response to the cache (best-effort; never throws). */
function writeCache(cwd: string, cache: CacheFile): void {
  try {
    mkdirSync(cacheDir(cwd), { recursive: true });
    writeFileSync(cachePath(cwd), JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
    // Cache writes are best-effort; never fail the command over them.
  }
}

/** Build the User-Agent string the endpoint requires (must be claude-code/*). */
function userAgent(version: string): string {
  // The endpoint 429s without a claude-code/* User-Agent.
  return `claude-code/${version}`;
}

/** Options for a single low-level usage fetch. */
export interface FetchUsageOptions {
  version: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Single live request to the usage endpoint. Throws UsageError on failure. */
export async function fetchClaudeUsage(token: string, opts: FetchUsageOptions): Promise<UsageData> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(USAGE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        'User-Agent': userAgent(opts.version),
      },
    });
  } catch (err) {
    throw new UsageError(
      `Network error contacting the Claude usage endpoint: ${(err as Error).message}`,
      'network',
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new UsageError('Claude rejected the token (HTTP ' + res.status + ').', 'unauthenticated');
  }
  if (res.status === 429) {
    throw new UsageError('Claude usage endpoint is rate-limited (HTTP 429).', 'rate_limited');
  }
  if (!res.ok) {
    throw new UsageError(`Claude usage endpoint returned HTTP ${res.status}.`, 'http');
  }

  try {
    return (await res.json()) as UsageData;
  } catch (err) {
    throw new UsageError(`Failed to parse usage response: ${(err as Error).message}`, 'http');
  }
}

/** Options for the high-level cached usage accessor {@link getUsage}. */
export interface GetUsageOptions extends FetchUsageOptions {
  token: string;
  cwd?: string;
  /** Bypass the cache and force a live fetch. */
  refresh?: boolean;
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: number;
}

/**
 * High-level accessor: returns fresh cache when available, otherwise fetches
 * live and updates the cache. On refresh failure, returns stale cache if present,
 * else rethrows the UsageError.
 */
export async function getUsage(opts: GetUsageOptions): Promise<UsageResult> {
  const cwd = opts.cwd ?? process.cwd();
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now();
  const cache = readCache(cwd);

  if (!opts.refresh && cache && now - cache.fetchedAt < ttl) {
    return { data: cache.data, fetchedAt: cache.fetchedAt, stale: false, source: 'cache' };
  }

  try {
    const data = await fetchClaudeUsage(opts.token, { version: opts.version, fetchImpl: opts.fetchImpl });
    writeCache(cwd, { fetchedAt: now, data });
    return { data, fetchedAt: now, stale: false, source: 'live' };
  } catch (err) {
    // Only fall back to cache for transient failures (network / rate-limit).
    // Auth and other HTTP/parse errors must surface so the caller can prompt
    // re-authentication instead of showing stale usage after a revoked token.
    const transient = err instanceof UsageError && (err.code === 'network' || err.code === 'rate_limited');
    if (transient && cache) {
      return { data: cache.data, fetchedAt: cache.fetchedAt, stale: true, source: 'cache' };
    }
    throw err;
  }
}
