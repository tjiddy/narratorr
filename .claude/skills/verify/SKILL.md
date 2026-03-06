---
name: verify
description: Run quality gates (lint, test, typecheck, build) via subagent and return
  a structured pass/fail summary. Use when user says "run checks", "verify", "quality
  gates", or invokes /verify.
model: haiku
---

# /verify — Run quality gates and report structured results

Runs the project's quality gate commands sequentially and returns a compact structured summary. Designed to be invoked by other skills (`/handoff`, `/implement`) to keep verbose build output out of the main context.

## Steps

1. **Determine quality gate commands.** Read the project's `CLAUDE.md` and look for a `## Commands` or `## Quality Gates` section. Extract the commands for:
   - **Lint** (e.g., `pnpm lint`, `ruff check .`, `cargo clippy`)
   - **Test** (e.g., `pnpm test`, `pytest`, `cargo test`)
   - **Typecheck** (e.g., `pnpm typecheck`, `mypy .`, — skip if not applicable)
   - **Build** (e.g., `pnpm build`, `cargo build`, `go build ./...`)

   If no explicit quality gates section exists, infer from the tech stack described in CLAUDE.md. If you truly can't determine the commands, ask the user.

2. **Run each gate sequentially.** For each command, capture the exit code and extract only failure details (not full output):

   - If it passes, note `pass` and any relevant count (e.g., number of tests passed)
   - If it fails, extract the first 3-5 actionable error messages (not the full log)
   - Stop running subsequent gates if one fails — report remaining as `skipped`

3. **Coverage gate (after all other gates pass).** Check if the project's `CLAUDE.md` mentions a coverage gate or convention. If it does:

   a. Get the list of source files changed on this branch vs the main branch:
      ```bash
      git diff --name-only --diff-filter=ACMR $(git merge-base HEAD main)..HEAD
      ```
   b. Filter to source files only (exclude test files like `*.test.ts`, `*.test.tsx`, `*.spec.*`, config files, markdown, etc.)
   c. Run tests with coverage enabled. The exact command depends on the project's test runner:
      - **Vitest (pnpm/npm/yarn):** Run vitest directly per package (turbo doesn't forward `--coverage`):
        `npx vitest run --coverage --coverage.reporter=json-summary` in each package directory that has changed files.
        Output: `<package>/coverage/coverage-summary.json`
      - **Jest:** `npx jest --coverage --coverageReporters=json-summary`
      - **pytest:** `pytest --cov --cov-report=json` (writes `coverage.json`)
      - Adapt for other runners as needed. If unsure, check `CLAUDE.md` or package.json for hints.
      - **Requires** `@vitest/coverage-v8` (or equivalent) to be installed. If missing, report `skip (coverage provider not installed)`.
   d. Read the coverage summary JSON and check each changed source file. The JSON format has file paths as keys with `{ lines: { pct: N } }`. Flag any file at **0% line coverage** (meaning zero test coverage at all). Files with tiny percentages like 1-3% from import evaluation should also be flagged — use a threshold of **≤5% line coverage** to catch these.
   e. Report result:
      - `pass` if all changed source files have >0% coverage
      - `fail` with the list of 0%-coverage files if any exist
      - `skip` if no coverage convention is mentioned in CLAUDE.md, or if there are no changed source files

   **Important:** This gate is intentionally lenient — it only catches files with *zero* tests, not low coverage. The goal is preventing entirely untested code from shipping, not enforcing a coverage percentage.

4. **Return a structured summary** (this is the ONLY output — no verbose logs):

   ```
   LINT: pass | fail (N errors: <first 3>)
   TEST: pass (N suites, M tests) | fail (N failed: <test names>)
   TYPECHECK: pass | fail (<first 5 errors>) | skipped (not applicable)
   BUILD: pass | fail (<error summary>)
   COVERAGE: pass | fail (N files at 0%: <file list>) | skipped
   OVERALL: pass | fail
   ```

5. **Total output to main context must be ~5-15 lines.** Truncate everything else.

## Important

- This skill is a **utility** — it does NOT fix failures, it only reports them
- The calling skill (`/handoff`, `/implement`) decides what to do with failures
- Do NOT run gates in parallel — they must be sequential (test depends on build artifacts, etc.)
- Do NOT create temp files or write output anywhere — just return structured text
- Run all commands from the repo root
- The coverage gate runs LAST because it re-runs tests with coverage instrumentation — don't run it if earlier gates already failed
