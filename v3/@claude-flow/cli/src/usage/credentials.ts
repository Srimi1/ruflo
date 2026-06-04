/**
 * Claude Code OAuth credential resolution.
 *
 * The `usage` command reuses Claude Code's existing login rather than running its
 * own OAuth flow. Claude Code stores the subscription OAuth token in one of three
 * places depending on platform; we resolve it in precedence order and NEVER log,
 * print, persist, or cache the token itself.
 *
 *   1. CLAUDE_CODE_OAUTH_TOKEN env var (explicit override)
 *   2. macOS Keychain  — service "Claude Code-credentials", account $USER
 *   3. File            — $CLAUDE_CONFIG_DIR/.credentials.json or ~/.claude/.credentials.json
 *
 * @module @claude-flow/cli/usage/credentials
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type TokenSource = 'env' | 'keychain' | 'file';

export interface ResolvedToken {
  token: string;
  source: TokenSource;
  /** Epoch milliseconds when the token expires, if the store records it. */
  expiresAt?: number;
}

interface ClaudeCredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

/** Parse the Claude Code credentials JSON shape into a token (or null). */
function parseCredentialsJson(raw: string, source: TokenSource): ResolvedToken | null {
  try {
    const data = JSON.parse(raw) as ClaudeCredentialsFile;
    const oauth = data.claudeAiOauth;
    const token = oauth?.accessToken;
    if (!token || !token.trim()) return null;
    return { token: token.trim(), source, expiresAt: oauth?.expiresAt };
  } catch {
    return null;
  }
}

/** Path to Claude Code's credentials file, honoring CLAUDE_CONFIG_DIR. */
export function credentialsFilePath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const base = configDir && configDir.trim() ? configDir.trim() : join(homedir(), '.claude');
  return join(base, '.credentials.json');
}

/** macOS only: pull the credentials blob out of the login Keychain. */
function readFromKeychain(): ResolvedToken | null {
  if (process.platform !== 'darwin') return null;
  try {
    const account = process.env.USER || process.env.LOGNAME || '';
    const args = ['find-generic-password', '-s', 'Claude Code-credentials'];
    // Omit the -a account filter when the username is unavailable (launchd, some
    // CI shells); otherwise `-a ""` fails to match the real stored account.
    if (account) args.push('-a', account);
    args.push('-w');
    const out = execFileSync('security', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return parseCredentialsJson(out.trim(), 'keychain');
  } catch {
    // Not present in the Keychain, or `security` unavailable — fall through.
    return null;
  }
}

/** Read the credentials file (Linux/Windows, or macOS fallback). */
function readFromFile(): ResolvedToken | null {
  const path = credentialsFilePath();
  if (!existsSync(path)) return null;
  try {
    return parseCredentialsJson(readFileSync(path, 'utf-8'), 'file');
  } catch {
    return null;
  }
}

/**
 * Resolve a Claude Code OAuth token, or null if the user is not logged in.
 * Precedence: env override → macOS Keychain → credentials file.
 */
export async function resolveClaudeOAuthToken(): Promise<ResolvedToken | null> {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken && envToken.trim()) {
    return { token: envToken.trim(), source: 'env' };
  }
  return readFromKeychain() ?? readFromFile();
}

/** True if the resolved token records an expiry that has already passed. */
export function isTokenExpired(resolved: ResolvedToken, now: number = Date.now()): boolean {
  if (!resolved.expiresAt) return false;
  return resolved.expiresAt <= now;
}
