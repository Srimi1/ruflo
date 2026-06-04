/**
 * Console filter installed at the top of every entry point. Four jobs:
 *
 * 1. Suppress the cosmetic "[AgentDB Patch] Controller index not found"
 *    warning emitted by agentic-flow's runtime patch (it expects agentdb
 *    v1.x layout but we use v3). Tight match: requires BOTH the prefix
 *    AND the specific message. Other [AgentDB Patch] messages flow through.
 *    Audit log audit_1776483149979 flagged the previous broad filter as
 *    too aggressive — this one is tight enough to be safe.
 *
 * 2. (#2253, #2256) Redirect noisy stdout writes from upstream embedder
 *    libraries (ruvector ONNX loader, ruvector-onnx-embeddings-wasm
 *    parallel embedder) to stderr. The libraries use `console.log` for
 *    progress messages like "Loading model:" and "  Downloading: ...",
 *    which corrupts MCP JSON-RPC stdio (#2253) and is generally noise on
 *    stdout.
 *
 * 3. Suppress agentdb's mock-embedder-fallback warning cluster emitted by
 *    `agentdb/dist/controllers/EmbeddingService.js` lines 48–56 when
 *    transformers.js initialisation fails (commonly: macOS arm64 without
 *    `brew install vips` — sharp can't load `libvips-cpp.42.dylib`). The
 *    warnings advertise that agentdb is "falling back to mock embeddings"
 *    — but `memory-bridge.ts::rescueAgentdbEmbedder` monkey-patches
 *    agentdb's embedder to delegate to our working ruvector ONNX pipeline
 *    in that exact case, so the user is NOT actually on mock embeddings.
 *    Letting the warning through is misleading and gets reported as a
 *    bug (user-reported 2026-06-02, no GH issue). Suppression is safe
 *    because the rescue handles the underlying condition; if the rescue
 *    itself fails, the user still sees `[WARN] No results found` from
 *    the calling command which surfaces the real symptom.
 *
 * 4. (`--quiet` / `-Q`) Fully suppress the upstream embedder boot banner
 *    ("Loading ONNX model: ...", "ONNX embedder ready: ...", "  Disk cache
 *    hit: ...") on BOTH stdout and stderr. Without --quiet these are only
 *    redirected to stderr (job 2); with --quiet they are dropped entirely —
 *    for cron/scripts that want a silent run. --quiet/-Q is a registered
 *    global flag (parser.ts); we read it from argv here because this module
 *    loads before arg parsing.
 *
 * This file MUST be imported as the first side-effect import in any entry
 * point so the patch is in place before agentic-flow / ruvector / agentdb
 * (and anything that transitively imports them) loads. ES module imports
 * are evaluated before the file's own top-level code, so putting this in
 * src/index.ts directly would race with transitive eager imports.
 */

const isCosmeticAgentdbPatchNoise = (msg: unknown): boolean => {
  const s = String(msg ?? '');
  return s.includes('[AgentDB Patch]') && s.includes('Controller index not found');
};

// #2253 / #2256: prefixes from third-party embedder libs that come out on
// stdout via console.log and corrupt MCP JSON-RPC. We redirect to stderr.
// Match is anchored to known prefixes only — anything else (e.g. legitimate
// user-facing CLI output) is unaffected.
const STDERR_REDIRECT_PREFIXES = [
  'Loading model: ',                // ruvector + ruvector-onnx-embeddings-wasm loader.js
  '  Downloading: ',                // ruvector + ruvector-onnx-embeddings-wasm loader.js
  '  Cache hit: ',                  // ruvector + ruvector-onnx-embeddings-wasm loader.js
  'Model cache cleared',            // ruvector + ruvector-onnx-embeddings-wasm loader.js
  '🚀 Initializing ',               // ruvector-onnx-embeddings-wasm parallel-embedder.mjs
  '✅ ',                            // ruvector-onnx-embeddings-wasm parallel-embedder.mjs (workers ready)
  '  Disk cache hit: ',             // ruvector-onnx-embeddings-wasm parallel-embedder.mjs
];

// (4) `--quiet` / `-Q`: when set, the embedder boot banner is dropped entirely
// rather than redirected to stderr. Read from argv because this module loads
// before the parser runs. Honour explicit negation (--no-quiet); match a
// short-flag cluster containing Q since boolean shorts can combine (e.g. -rQ).
const QUIET: boolean = (() => {
  const argv = process.argv.slice(2);
  if (argv.includes('--no-quiet')) return false;
  if (argv.includes('--quiet')) return true;
  return argv.some((a) => /^-[A-Za-z]*Q[A-Za-z]*$/.test(a));
})();

// Embedder boot lines emitted via console.error (NOT covered by the console.log
// redirect list above — e.g. ruvector's onnx-embedder.js / onnx-optimized.js)
// plus the "Loading ONNX model" lines from agentic-flow. Pinned to known
// upstream prefixes; matched with startsWith so unrelated output is untouched.
const EMBEDDER_BOOT_PREFIXES = [
  'ONNX embedder ready: ',           // ruvector/dist/core/onnx-embedder.js (console.error)
  'Optimized ONNX embedder ready: ', // ruvector/dist/core/onnx-optimized.js (console.error)
  '📦 Loading ONNX model: ',         // agentic-flow onnx.js / onnx-local.js (console.log)
  'Loading ONNX model: ',            // emoji-less variant
];

const isEmbedderBootNoise = (msg: unknown): boolean => {
  const s = String(msg ?? '');
  for (const prefix of EMBEDDER_BOOT_PREFIXES) {
    if (s.startsWith(prefix)) return true;
  }
  return false;
};

// (3) Suppress the agentdb mock-embedder-fallback cluster. Each entry below
// matches the EXACT prefix `console.warn` argument from
// agentdb/dist/controllers/EmbeddingService.js:48–56. Keep this list
// pinned to upstream lines, not broadened heuristically — broader filters
// risk hiding real signals (audit_1776483149979 lesson).
const AGENTDB_MOCK_FALLBACK_DROP_PREFIXES = [
  'Transformers.js initialization failed:',        // line 48 — multi-line because the error has multi-line .message
  '   Falling back to mock embeddings for testing', // line 49
  '   This is normal if:',                          // line 50
  '     - Running offline/without internet access', // line 51
  '     - Model not yet downloaded',                // line 52
  '     - Network connectivity issues',             // line 53
  '   To use real embeddings:',                     // line 54
  '     - Ensure internet connectivity for first',  // line 55
  '     - Or pre-download: npx agentdb',            // line 56
];

const shouldRedirectToStderr = (msg: unknown): boolean => {
  const s = String(msg ?? '');
  for (const prefix of STDERR_REDIRECT_PREFIXES) {
    if (s.startsWith(prefix)) return true;
  }
  return false;
};

const isAgentdbMockFallbackNoise = (msg: unknown): boolean => {
  const s = String(msg ?? '');
  for (const prefix of AGENTDB_MOCK_FALLBACK_DROP_PREFIXES) {
    if (s.startsWith(prefix)) return true;
  }
  return false;
};

const origWarn = console.warn.bind(console);
const origLog = console.log.bind(console);
const origError = console.error.bind(console);

console.warn = (...args: unknown[]) => {
  if (isCosmeticAgentdbPatchNoise(args[0])) return;
  if (isAgentdbMockFallbackNoise(args[0])) return;
  origWarn(...args);
};
console.log = (...args: unknown[]) => {
  if (isCosmeticAgentdbPatchNoise(args[0])) return;
  // --quiet: drop embedder boot noise entirely instead of redirecting it.
  if (QUIET && (shouldRedirectToStderr(args[0]) || isEmbedderBootNoise(args[0]))) return;
  if (shouldRedirectToStderr(args[0])) {
    origError(...args);
    return;
  }
  origLog(...args);
};

// console.error is patched ONLY to honour --quiet for the embedder boot banner
// (e.g. ruvector's "ONNX embedder ready: ..."). All other error output — real
// diagnostics — flows through untouched, and without --quiet this is a no-op.
console.error = (...args: unknown[]) => {
  if (QUIET && isEmbedderBootNoise(args[0])) return;
  origError(...args);
};
