---
name: verify
description: Run quality gates (lint, test, typecheck, build) via subagent and return
  a structured pass/fail summary. Use when user says "run checks", "verify", "quality
  gates", or invokes /verify.
model: sonnet
---

!`cat .claude/docs/testing.md`

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

   - **Lint:** Run the lint command. If it passes, note `pass`. If it fails, extract the first 3-5 actionable error messages.
   - **Test (with coverage):** Run tests with coverage in a single command — do NOT run tests twice. The exact command depends on the project's test runner:
     - **Vitest:** `pnpm exec vitest run --coverage --coverage.reporter=json-summary`
     - **Jest:** `npx jest --coverage --coverageReporters=json-summary`
     - **pytest:** `pytest --cov --cov-report=json`
     - **Requires** `@vitest/coverage-v8` (or equivalent) to be installed. If missing, run tests without coverage and report coverage as `skip (coverage provider not installed)`.

     From this single run, extract both:
     - **TEST result:** pass/fail with suite and test counts
     - **Coverage data:** saved to `coverage/coverage-summary.json` (Vitest) or equivalent for later analysis
   - **Typecheck:** Run the typecheck command.
   - **Build:** Run the build command.
   - If any gate fails, stop — report remaining gates as `skipped`

3. **Coverage analysis (after all gates pass).** Check if the project's `CLAUDE.md` mentions a coverage gate or convention. If it does:

   a. Get the list of source files changed on this branch vs the main branch:
      ```bash
      git diff --name-only --diff-filter=ACMR $(git merge-base HEAD main)..HEAD
      ```
   b. Filter to source files only (exclude test files like `*.test.ts`, `*.test.tsx`, `*.spec.*`, config files, markdown, etc.)
   c. Read `coverage/coverage-summary.json` (already generated in step 2) and check each changed source file. The JSON format has file paths as keys with `{ lines: { pct: N } }`. Flag any file at **≤5% line coverage**. This catches both truly untested files (0%) and files where the only "coverage" is import/evaluation side effects (1-3%).
   d. Report result:
      - `pass` if all changed source files have >5% coverage
      - `fail` with the list of under-covered files and their percentages
      - `skip` if no coverage convention is mentioned in CLAUDE.md, no changed source files, or coverage data wasn't generated

4. **Return a structured summary** (this is the ONLY output — no verbose logs):

   ```
   LINT: pass | fail (N errors: <first 3>)
   TEST: pass (N suites, M tests) | fail (N failed: <test names>)
   TYPECHECK: pass | fail (<first 5 errors>) | skipped (not applicable)
   BUILD: pass | fail (<error summary>)
   COVERAGE: pass | fail (N files at 0%: <file list>) | skipped
   OVERALL: pass | fail
   ---
   CALLER: This is a sub-skill result, not a stopping point. Continue to your next step immediately.
   ```

   **The `CALLER:` line is mandatory.** It reminds the parent agent that this result is mid-workflow. Do not omit it.

5. **Total output to main context must be ~5-15 lines.** Truncate everything else.

## Important

- This skill is a **utility** — it does NOT fix failures, it only reports them
- The calling skill (`/handoff`, `/implement`) decides what to do with failures
- Do NOT run gates in parallel — they must be sequential
- Do NOT run tests twice — the test step already includes coverage instrumentation
- Do NOT create temp files or write output anywhere — just return structured text
- Run all commands from the repo root
- Coverage analysis is a post-processing step on data already collected during the test run — it does NOT re-run tests
