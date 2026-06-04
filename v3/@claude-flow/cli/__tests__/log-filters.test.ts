/**
 * Tests for src/log-filters.ts — the console filter installed at every entry
 * point.
 *
 * The module reads `process.argv` and patches the global `console` methods at
 * IMPORT time (the QUIET flag is a top-level const). So each scenario must:
 *   1. install fresh vi.fn() spies as console.log/error/warn — these become the
 *      "originals" the module binds via `console.X.bind(console)`,
 *   2. set process.argv,
 *   3. vi.resetModules() + dynamic import so the patch re-runs against (1)/(2).
 *
 * After import, console.log/error are the PATCHED versions; calling them routes
 * (or doesn't) to the spies, which is what we assert on.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

const realLog = console.log;
const realError = console.error;
const realWarn = console.warn;
const realArgv = process.argv;

/** Install spies, set argv, re-import log-filters fresh. Returns the spies. */
async function loadFilters(extraArgv: string[]) {
  const logSpy = vi.fn();
  const errSpy = vi.fn();
  const warnSpy = vi.fn();
  console.log = logSpy as unknown as typeof console.log;
  console.error = errSpy as unknown as typeof console.error;
  console.warn = warnSpy as unknown as typeof console.warn;
  // argv[0]/[1] are node + script; the CLI's real args start at slice(2).
  process.argv = ['node', 'claude-flow', 'usage', ...extraArgv];
  vi.resetModules();
  await import('../src/log-filters.js');
  return { logSpy, errSpy, warnSpy };
}

afterEach(() => {
  console.log = realLog;
  console.error = realError;
  console.warn = realWarn;
  process.argv = realArgv;
  vi.resetModules();
});

describe('log-filters', () => {
  describe('default (no --quiet)', () => {
    it('redirects embedder console.log noise to stderr, never stdout', async () => {
      const { logSpy, errSpy } = await loadFilters([]);
      console.log('  Disk cache hit: all-MiniLM-L6-v2');
      expect(logSpy).not.toHaveBeenCalled(); // kept off stdout (protects JSON/JSON-RPC)
      expect(errSpy).toHaveBeenCalledTimes(1); // redirected to stderr instead
    });

    it('passes normal stdout through untouched', async () => {
      const { logSpy } = await loadFilters([]);
      console.log('hello world');
      expect(logSpy).toHaveBeenCalledWith('hello world');
    });

    it('lets the embedder boot banner reach stderr (not muted without --quiet)', async () => {
      const { errSpy } = await loadFilters([]);
      console.error('ONNX embedder ready: 384d, SIMD: true');
      expect(errSpy).toHaveBeenCalledTimes(1);
    });

    it('lets real errors through console.error', async () => {
      const { errSpy } = await loadFilters([]);
      console.error('boom: something genuinely failed');
      expect(errSpy).toHaveBeenCalledWith('boom: something genuinely failed');
    });

    it('drops the cosmetic AgentDB-patch noise', async () => {
      const { logSpy, errSpy } = await loadFilters([]);
      console.log('[AgentDB Patch] Controller index not found, skipping');
      expect(logSpy).not.toHaveBeenCalled();
      expect(errSpy).not.toHaveBeenCalled();
    });
  });

  describe('with --quiet', () => {
    it('drops embedder console.log noise entirely (stdout AND stderr)', async () => {
      const { logSpy, errSpy } = await loadFilters(['--quiet']);
      console.log('  Disk cache hit: all-MiniLM-L6-v2');
      console.log('📦 Loading ONNX model: all-MiniLM-L6-v2');
      console.log('Loading ONNX model: all-MiniLM-L6-v2...');
      expect(logSpy).not.toHaveBeenCalled();
      expect(errSpy).not.toHaveBeenCalled();
    });

    it('drops the console.error boot banner ("ONNX embedder ready")', async () => {
      const { errSpy } = await loadFilters(['--quiet']);
      console.error('ONNX embedder ready: 384d, SIMD: true');
      console.error('Optimized ONNX embedder ready: 384d, SIMD: true, Cache: 512');
      expect(errSpy).not.toHaveBeenCalled();
    });

    it('still emits normal stdout', async () => {
      const { logSpy } = await loadFilters(['--quiet']);
      console.log('hello world');
      expect(logSpy).toHaveBeenCalledWith('hello world');
    });

    it('still emits real errors (only the boot banner is muted)', async () => {
      const { errSpy } = await loadFilters(['--quiet']);
      console.error('boom: real failure');
      expect(errSpy).toHaveBeenCalledWith('boom: real failure');
    });
  });

  describe('flag variants', () => {
    it('-Q short flag also mutes the banner', async () => {
      const { errSpy } = await loadFilters(['-Q']);
      console.error('ONNX embedder ready: 384d, SIMD: true');
      expect(errSpy).not.toHaveBeenCalled();
    });

    it('-Q inside a combined short cluster (e.g. -rQ) mutes', async () => {
      const { errSpy } = await loadFilters(['-rQ']);
      console.error('ONNX embedder ready: 384d, SIMD: true');
      expect(errSpy).not.toHaveBeenCalled();
    });

    it('--no-quiet keeps default behavior (redirect, not drop)', async () => {
      const { logSpy, errSpy } = await loadFilters(['--no-quiet']);
      console.log('  Disk cache hit: all-MiniLM-L6-v2');
      expect(logSpy).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledTimes(1); // redirected to stderr, not dropped
    });
  });
});
