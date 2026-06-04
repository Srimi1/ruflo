---
name: "Bug Hunter & Fix Reporter"
description: "Systematically find bugs (tests, type errors, lint, static analysis, runtime), fix them safely, verify the fixes, and produce a structured Markdown bug report. Use when asked to find and fix bugs, triage failures, clean up a failing build, audit a module for defects, or generate a bug/fix report."
---

# Bug Hunter & Fix Reporter

## What This Skill Does

Runs a disciplined **find → triage → fix → verify → report** loop:

1. **Find** bugs from multiple signals: failing tests, type errors, lint, and targeted code review.
2. **Triage** findings by severity and root cause (not just symptoms).
3. **Fix** the smallest correct change for each real bug — no scope creep.
4. **Verify** every fix by re-running the exact check that caught it.
5. **Report** what was found, what changed, and proof it's fixed — as a Markdown file under `docs/`.

Use it when a build is red, a module feels buggy, or someone asks for a "find and fix the bugs + report" pass.

## Prerequisites

- A project with at least one diagnostic available (test runner, `tsc`, linter, or a runnable entrypoint).
- Permission to edit source files and run the project's test/lint commands.

---

## Quick Start

```bash
# 1. Gather diagnostics (read-only — never edits anything)
bash .claude/skills/bug-hunter/scripts/scan.sh

# 2. Claude reads the output, fixes real bugs, re-runs the failing checks

# 3. Write the report from the template
cp .claude/skills/bug-hunter/resources/templates/bug-report-template.md \
   docs/bug-report-$(date +%Y%m%d).md
```

Then fill in the report and confirm all checks are green.

---

## Step-by-Step Guide

### Step 1 — Find (gather evidence, change nothing)

Run the scan helper, or invoke the diagnostics directly. Prefer the project's own scripts.

```bash
bash .claude/skills/bug-hunter/scripts/scan.sh            # whole repo
bash .claude/skills/bug-hunter/scripts/scan.sh src/auth   # scope to a path
```

The scan collects, best-effort and non-destructively:
- **Tests** — the package's `test` script (vitest/jest/pytest/go test…).
- **Types** — `tsc --noEmit` when a `tsconfig.json` exists.
- **Lint** — the `lint` script or `eslint`/`ruff`/`golangci-lint` if present.
- **Smells** — `FIXME`/`HACK`/`XXX`, leftover `debugger`, `.only(` focused tests, etc.

Capture the raw failures verbatim — they are the bug list.

### Step 2 — Triage (classify before touching code)

For each finding, record:
- **Severity**: `critical` (crash/data loss/security) · `high` (wrong result) · `medium` (edge case) · `low` (smell).
- **Root cause**, not the symptom — trace the failing assertion or stack to the line that's actually wrong.
- **Real vs noise**: flaky tests, environment gaps (missing deps), and intentional patterns are **not** bugs — note them and move on. Do not "fix" a test by weakening its assertion.

### Step 3 — Fix (smallest correct change)

- One logical fix per bug; keep edits minimal and in the style of the surrounding code.
- Read the file before editing; never guess at context.
- If a fix needs a design decision or a large refactor, **stop and surface it** instead of forcing it.
- Add or tighten a test when the bug had no coverage and the fix is behavioral.

### Step 4 — Verify (prove each fix)

Re-run the **exact** check that caught the bug, then the full suite:

```bash
# the specific failing check first…
npx vitest run path/to/failing.test.ts
# …then everything, to catch regressions
bash .claude/skills/bug-hunter/scripts/scan.sh
```

A fix isn't done until its check is green and nothing else went red. Report failures honestly — never claim green without the passing output.

### Step 5 — Report

Copy the template and fill every section. Save under `docs/` (never the repo root):

```bash
cp .claude/skills/bug-hunter/resources/templates/bug-report-template.md \
   docs/bug-report-$(date +%Y%m%d).md
```

See [`resources/templates/bug-report-template.md`](resources/templates/bug-report-template.md) for the structure: summary table, per-bug detail (symptom → root cause → fix → verification), and remaining risks.

---

## Reference

### Severity rubric

| Severity | Meaning | Example |
|----------|---------|---------|
| critical | crash, data loss, security hole | unhandled `null` deref on hot path, auth bypass |
| high | produces wrong output | off-by-one, inverted condition, bad rounding |
| medium | breaks on edge cases | empty input, timezone, large values |
| low | smell / latent risk | dead code, `console.log`, weak typing |

### Rules

- **Don't weaken tests to make them pass.** Fix the code, or flag the test as wrong with reasoning.
- **Don't expand scope.** Out-of-scope defects you spot go in the report's "Further findings", not into this diff.
- **Pre-existing/environment failures** (missing deps, unbuilt siblings) are reported as such, not silently "fixed".
- **Keep the report truthful**: if a check couldn't run, say so.

### Troubleshooting

- **Scan finds no test runner** — pass a path to narrow scope, or run the relevant tool directly; record in the report that automated signals were limited.
- **A fix cascades into many files** — pause; that's a refactor, not a bug fix. Summarize the options and ask before proceeding.
- **Flaky test** — re-run a few times; if non-deterministic, mark it flaky in the report rather than chasing a phantom fix.
