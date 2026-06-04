# Bug Report — <PROJECT / SCOPE>

- **Date**: <YYYY-MM-DD>
- **Scope**: <files / module / "whole repo">
- **Signals run**: tests [pass/fail] · types [pass/fail] · lint [pass/fail] · review [done]
- **Result**: <N bugs found · M fixed · K deferred>

## Summary

| # | Severity | Area | Bug (one line) | Status |
|---|----------|------|----------------|--------|
| 1 | critical/high/medium/low | `path/to/file` | … | fixed / deferred |
| 2 | | | | |

## Bugs found & fixed

### Bug 1 — <short title>
- **Severity**: <critical/high/medium/low>
- **Location**: `path/to/file.ts:42`
- **Symptom**: what was observed (failing test name, error, wrong output).
- **Root cause**: the actual defect (not the symptom).
- **Fix**: what changed and why it's the minimal correct change.
- **Verification**: exact command + result that proves it's fixed.
  ```
  $ npx vitest run path/to/failing.test.ts
  ✓ 3 passed
  ```

### Bug 2 — <short title>
<repeat the structure>

## Deferred / out of scope

Real issues found but **not** fixed in this pass (need a decision or a larger refactor):

- `path/to/file` — description — why deferred (scope/risk/ambiguity).

## Not bugs (investigated, no action)

- Flaky test `…` — non-deterministic, not a code defect.
- Pre-existing/environment failure `…` — e.g. missing optional dependency.

## Verification — final state

```
# full diagnostics after fixes
$ bash .claude/skills/bug-hunter/scripts/scan.sh
TESTS: <pass>   TYPES: <pass>   LINT: <pass>
```

## Remaining risks

- Anything still uncertain, untested paths, or follow-ups worth tracking.
