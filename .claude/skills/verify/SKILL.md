# /verify — Run quality gates and report structured results

Runs all quality gates sequentially and returns a compact structured summary. Designed to be invoked by other skills (`/handoff`, `/implement`) to keep verbose build output out of the main context.

## Steps

1. **Run each gate sequentially.** For each command, capture the exit code and extract only failure details (not full output):

   a. **Lint:** `pnpm lint`
   b. **Test:** `pnpm test`
   c. **Typecheck:** `pnpm typecheck`
   d. **Build:** `pnpm build`

2. **For each gate:**
   - If it passes, note `pass` and any relevant count (e.g., number of tests passed)
   - If it fails, extract the first 3-5 actionable error messages (not the full log)
   - Stop running subsequent gates if one fails — report remaining as `skipped`

3. **Return a structured summary** (this is the ONLY output — no verbose logs):

   ```
   LINT: pass | fail (N errors: <first 3>)
   TEST: pass (N suites, M tests) | fail (N failed: <test names>)
   TYPECHECK: pass | fail (<first 5 errors>)
   BUILD: pass | fail (<error summary>)
   OVERALL: pass | fail
   ```

4. **Total output to main context must be ~5-10 lines.** Truncate everything else.

## Important

- This skill is a **utility** — it does NOT fix failures, it only reports them
- The calling skill (`/handoff`, `/implement`) decides what to do with failures
- Do NOT run gates in parallel — they must be sequential (test depends on build artifacts, etc.)
- Do NOT create temp files or write output anywhere — just return structured text
- Run all commands from the repo root
