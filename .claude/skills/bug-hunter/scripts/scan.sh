#!/usr/bin/env bash
# Bug Hunter — read-only diagnostics collector.
# Gathers test / type / lint failures and common smells. NEVER edits files.
#
# Usage:
#   bash scripts/scan.sh [path]
#     path  optional sub-directory to scope smell scanning (default: repo root)
#
# Exit code is always 0 — this is an evidence collector, not a gate. Read the
# output to build the bug list; the per-section "FAIL" markers are the findings.

set -uo pipefail
SCOPE="${1:-.}"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT" || exit 0

section() { printf '\n=== %s ===\n' "$1"; }
have()    { command -v "$1" >/dev/null 2>&1; }

# Pick the package manager that matches the lockfile.
pm=""
if   [ -f pnpm-lock.yaml ]; then pm="pnpm"
elif [ -f yarn.lock ];      then pm="yarn"
elif [ -f package-lock.json ] || [ -f package.json ]; then pm="npm"
fi

section "ENVIRONMENT"
echo "root: $ROOT"
echo "scope: $SCOPE"
echo "node: $(node -v 2>/dev/null || echo n/a)   pkg-manager: ${pm:-none}"

# ---- Tests --------------------------------------------------------------
section "TESTS"
if [ -n "$pm" ] && grep -q '"test"' package.json 2>/dev/null; then
  case "$pm" in
    npm)  npm test --silent 2>&1 ;;
    pnpm) pnpm test 2>&1 ;;
    yarn) yarn test 2>&1 ;;
  esac | tail -n 60 || echo "FAIL: test script errored (see above)"
elif have pytest && find . -path ./node_modules -prune -o -name '*.py' -print 2>/dev/null | grep -q .; then
  pytest -q 2>&1 | tail -n 60
elif have go && ls go.mod >/dev/null 2>&1; then
  go test ./... 2>&1 | tail -n 60
else
  echo "skip: no recognized test runner"
fi

# ---- Types --------------------------------------------------------------
section "TYPES (tsc --noEmit)"
if [ -f tsconfig.json ] && have npx; then
  npx --no-install tsc --noEmit 2>&1 | tail -n 40 || echo "skip: tsc unavailable"
else
  echo "skip: no tsconfig.json"
fi

# ---- Lint ---------------------------------------------------------------
section "LINT"
if [ -n "$pm" ] && grep -q '"lint"' package.json 2>/dev/null; then
  case "$pm" in
    npm)  npm run --silent lint 2>&1 ;;
    pnpm) pnpm lint 2>&1 ;;
    yarn) yarn lint 2>&1 ;;
  esac | tail -n 40
elif have ruff; then ruff check "$SCOPE" 2>&1 | tail -n 40
else echo "skip: no lint script / linter found"
fi

# ---- Smells (heuristic, not authoritative) ------------------------------
section "SMELLS"
GREP="grep -RIn --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git"
echo "-- FIXME/HACK/XXX/BUG markers:"
$GREP -E '\b(FIXME|HACK|XXX|BUG)\b' "$SCOPE" 2>/dev/null | head -n 25 || true
echo "-- leftover debuggers / focused tests:"
$GREP -E '\bdebugger\b|\.only\(|fdescribe|fit\(' "$SCOPE" 2>/dev/null | head -n 25 || true

section "DONE"
echo "Review FAIL lines and SMELLS above to build the bug list. Nothing was modified."
exit 0
