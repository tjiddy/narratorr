# Workflow Log

## #383 Upgrade Node.js 20 → 22 LTS — 2026-03-15
**Skill path:** /spec → /elaborate → /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #384

### Metrics
- Files changed: 9 | Tests added/modified: 1 (docker/s6-service.test.ts)
- Quality gate runs: 2 (fail on attempt 1 due to pre-existing stale node_modules, pass on attempt 2 after clean reinstall)
- Fix iterations: 1 (self-review caught missing Docker runner-stage version pinning)
- Context compactions: 0

### Workflow experience
- What went smoothly: Pure version bump, all edits mechanical, no dependency issues
- Friction / issues encountered: Pre-existing stale `node_modules` caused 37 test failures (ajv/dist/jtd missing) — fixed by `rm -rf node_modules && pnpm install`. Also caused a long detour earlier in the session diagnosing false Node version incompatibility.

### Token efficiency
- Highest-token actions: Security audit earlier in conversation (not part of this issue)
- Avoidable waste: The stale node_modules debugging consumed significant context before this issue started
- Suggestions: When tests fail unexpectedly, try clean reinstall before investigating Node/package compat

### Infrastructure gaps
- Repeated workarounds: Had to nuke node_modules on this clone — pnpm store may have corruption issues
- Missing tooling / config: No CI step to verify `node --version` inside Docker container (added to spec/AC but CI workflow doesn't implement it yet)
- Unresolved debt: Docker workflow should add `docker run <image> node --version | grep v22` step

### Wish I'd Known
1. The test failures were stale node_modules, not Node version issues — would have saved 30+ minutes of investigation
2. Docker multi-stage builds have independent Node sources (builder image vs runner apk) — need to pin both
3. CLAUDE.md also references the Node version — easy to miss in a version bump sweep

## #355 Add Pagination Infrastructure to Unbounded Queries — 2026-03-13
**Skill path:** /elaborate → /respond-to-spec-review (x4) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #373

### Metrics
- Files changed: ~35 | Tests added/modified: ~30
- Quality gate runs: 2 (pass on attempt 2 — lint fix in blacklist route)
- Fix iterations: 1 (blacklist.ts lint: `import type` + `return await`)
- Context compactions: 0

### Workflow experience
- What went smoothly: Service pattern was consistent across all four — once one was done, the rest were mechanical. TanStack Query's `select()` perfectly isolated the envelope unwrapping from component code.
- Friction / issues encountered: 4 rounds of spec review before approval — the core tension (can't enforce limits without pagination UI) took 3 rounds to resolve by rescoping as Phase 1/2. Stale merge conflicts in unrelated test files blocked first commit. mockDbChain missing `offset` method.

### Token efficiency
- Highest-token actions: Spec review rounds (4 rounds), Explore subagent for codebase exploration, batch test mock updates across ~100 sites
- Avoidable waste: The 4-round spec review cycle could have been 1-2 rounds if the original spec had honestly scoped as "infrastructure only" from the start
- Suggestions: When a spec says "add X to Y" but Y's consumers can't handle X without UI changes, scope as infrastructure-only immediately rather than iterating toward that conclusion

### Infrastructure gaps
- Repeated workarounds: Stale merge conflict markers from unrelated stashes blocking commits on every branch
- Missing tooling / config: mockDbChain should auto-generate all Drizzle chainable methods rather than maintaining a manual list
- Unresolved debt: BookService slim select uses explicit column list that must sync with schema

### Wish I'd Known
1. The fundamental tension between "bound queries" and "no pagination UI" would dominate spec review — should have scoped as Phase 1 infrastructure from the start
2. Response shape changes (array → envelope) have ~30-file blast radius — count callers before committing to the approach
3. TanStack Query's `query.state.data` in callbacks is always raw (pre-select), not the transformed value — this distinction matters for refetchInterval logic

## #357 Refactor Search Pipeline — Deduplicate search-and-grab loop, extract from routes — 2026-03-13
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #371

### Metrics
- Files changed: 10 | Tests added/modified: 2 (search-pipeline.test.ts new, search.test.ts updated)
- Quality gate runs: 2 (pass on attempt 2 — lint errors on first run)
- Fix iterations: 1 (lint: `import()` type annotation and unused import)
- Context compactions: 0

### Workflow experience
- What went smoothly: The extraction was clean — functions moved with no signature changes, tests moved with only import path updates. The 5-module plan worked well for a refactoring issue.
- Friction / issues encountered: Pre-existing merge conflicts in `ImportSettingsSection.test.tsx` and `SearchSettingsSection.test.tsx` blocked the first commit. Had to resolve them before any commit could proceed. Also, the `searched++` counter semantics changed subtly when deduplicating — the old code incremented after `searchAll` but before `grab`, so grab failures still counted. After extraction, grab failures throw and the counter doesn't increment. Required a test assertion update.

### Token efficiency
- Highest-token actions: Explore subagent for self-review and coverage review (both thorough)
- Avoidable waste: The spec review went 3 rounds (elaborate → respond → respond) before approval; most findings were from the initial elaboration not reading source carefully enough
- Suggestions: For deduplication issues, the elaboration subagent should independently grep for ALL instances of the pattern, not just validate what the spec names

### Infrastructure gaps
- Repeated workarounds: Pre-existing merge conflicts from stash required manual resolution on every new branch. `claim.ts` should detect and warn about UU files.
- Missing tooling / config: No automated merge conflict detection in `claim.ts`
- Unresolved debt: `runUpgradeSearchJob` still has its own loop (different enough to not fit `searchAndGrabForBook`); `jobs/search.ts` re-exports from `search-pipeline.ts` for backward compat

### Wish I'd Known
1. Pre-existing merge conflicts in settings test files would block ALL commits — should have resolved them immediately after `claim.ts` ran
2. The `searched` counter increment position between search and grab means deduplication changes counter semantics — always check counter placement relative to extracted boundaries
3. `runUpgradeSearchJob` has enough additional logic (quality comparison, double grab-floor check) that it can't simply call `searchAndGrabForBook` — it needed to stay as its own loop with only `buildSearchQuery` deduplication

## #358 API Naming Convention & Collision Guard Completeness — 2026-03-13
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #370

### Metrics
- Files changed: 29 | Tests added/modified: 10
- Quality gate runs: 3 (pass on attempt 3 — coverage gate caught missing useEventHistory.test.ts)
- Fix iterations: 3 (merge conflict resolution, replace_all overshoot on `logout`, coverage gate)
- Context compactions: 0

### Workflow experience
- What went smoothly: TypeScript strict mode made rename verification trivial — `pnpm typecheck` caught every missed caller
- Friction / issues encountered: Pre-existing merge conflicts in SearchSettingsSection.test.tsx and ImportSettingsSection.test.tsx blocked lint/verify. `git checkout --theirs` resolved the import line but left deeper conflicts. Settings test files from the stashed version assumed Save button always visible, but the component conditionally renders it only when `isDirty`. `replace_all` for `logout` was too aggressive — renamed hook's public API method alongside the internal API call.

### Token efficiency
- Highest-token actions: Reading all test files to understand mock patterns, self-review subagent
- Avoidable waste: Could have used targeted grep-based edits for test file renames instead of reading full files
- Suggestions: For mechanical rename refactors, batch the renames by grepping for all call sites first, then edit in parallel

### Infrastructure gaps
- Repeated workarounds: Pre-existing merge conflicts from stale stashes (same issue as #362 debt item)
- Missing tooling: `claim.ts` doesn't check for unmerged files before creating branches (existing debt item)
- Unresolved debt: CredentialsSection lacks dedicated test file (discovered, logged to debt.md)

### Wish I'd Known
1. TanStack Query prefix-matching semantics for `invalidateQueries` — `['eventHistory']` is broader than `['eventHistory', undefined]`. This was caught in spec review but would have been nice to know before writing the spec. (→ `tanstack-query-prefix-key-invalidation.md`)
2. `replace_all` is dangerous for method names shared between API modules and hook return values — `logout` exists on both `api` and `result.current`. (→ `replace-all-overshoot-hook-api.md`)
3. Settings section tests from pre-#362 branch assume Save button is always visible, but post-per-section-save components conditionally render it only when `isDirty`. (→ `merge-conflict-stash-upstream-save-button.md`)

## #362 Test Pattern Cleanup — Replace brittle selectors and fireEvent usage — 2026-03-13
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #369

### Metrics
- Files changed: 20 | Tests added/modified: 0 new, 20 files cleaned up (31 insertions, 38 deletions)
- Quality gate runs: 1 (pass on attempt 1)
- Fix iterations: 2 (number input isDirty constraint discovery, pre-existing merge conflict markers from stale stash)
- Context compactions: 1 (caused continuation session)

### Workflow experience
- What went smoothly: Mechanical replacements were straightforward — `container.innerHTML === ''` → `toBeEmptyDOMElement()`, `.animate-spin` → `getByTestId('loading-spinner')`, CSS class selectors → `getByTestId('modal-backdrop')`, `.previousElementSibling` → `getByRole('checkbox', { name })`. All 20 files passed on first verify run.
- Friction / issues encountered: (1) Pre-existing merge conflict markers from a stale `git stash pop` on main blocked ALL commits on every branch — took investigation to diagnose. (2) Attempted to convert `fireEvent.submit` to `userEvent` interactions on BackupScheduleForm but discovered RHF `valueAsNumber` + jsdom is fundamentally incompatible with making forms dirty through any event mechanism. (3) Context compaction mid-handoff required continuation session.

### Token efficiency
- Highest-token actions: Self-review and coverage review subagents (~60-80K each), M-32 number input exploration (4 failed approaches before confirming constraint)
- Avoidable waste: The M-32 exploration through `user.clear()`, `user.tripleClick()`, `fireEvent.change`, `fireEvent.input` could have been skipped — the learning from #339 already documented this constraint
- Suggestions: Check `.claude/cl/learnings/` for relevant constraints BEFORE attempting workarounds on known-problematic patterns

### Infrastructure gaps
- Repeated workarounds: `fireEvent.submit` for RHF number-input forms (BackupScheduleForm, NetworkSettingsSection) — same workaround documented twice now
- Missing tooling / config: claim.ts doesn't check for unmerged files from stale stashes before creating branches
- Unresolved debt: claim.ts unmerged file check (logged in debt.md)

### Wish I'd Known
1. Pre-existing merge conflict markers from `git stash pop` block ALL commits on every branch — always check `git status` for UU files before starting work (see `stash-conflict-markers-block-commit.md`)
2. The number input + RHF `valueAsNumber` + jsdom constraint was already documented in `number-input-rhf-isdirty-jsdom.md` from #339 — reading learnings upfront would have saved 4 failed approach attempts (see `number-input-rhf-isdirty-jsdom.md`)
3. For mechanical bulk-edit chore issues, the elaborate/spec-review cycle adds more overhead than value — the spec needed 2 review rounds to narrow scope that was obvious from reading the code directly

## #198 Custom post-processing script support — 2026-03-12
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #348

### Metrics
- Files changed: 7 | Tests added/modified: 24 (15 unit, 4 integration, 5 UI)
- Quality gate runs: 3 (pass on attempt 3 — first had lint errors, second had typecheck from unfixed fixtures)
- Fix iterations: 2 (lint: `as Function` → `as (...args: unknown[]) => void` + complexity extraction; typecheck: hardcoded processing fixtures missing new fields)
- Context compactions: 1 (caused need to re-read files but no rework)

### Workflow experience
- What went smoothly: Schema + utility module TDD was clean. Import service integration followed existing tag-embedding pattern perfectly.
- Friction / issues encountered: Settings fixture blast radius was the biggest time sink — 10+ hardcoded processing objects across test files needed updating. The `enabled: true` variants could be batch-replaced but `enabled: false` needed individual handling. Also hit merge conflicts with #341 branch on settings test files (Import/Library/Search sections).

### Token efficiency
- Highest-token actions: Coverage review subagent (92k tokens), self-review subagent (67k tokens)
- Avoidable waste: Could have planned the fixture blast radius as a distinct module upfront instead of discovering it during verify
- Suggestions: For settings schema changes, always grep for hardcoded fixtures before starting implementation to know the blast radius early

### Infrastructure gaps
- Repeated workarounds: Full processing object overrides in tests (10+ places) — should use partial overrides with createMockSettings()
- Missing tooling / config: No automated detection of hardcoded settings fixtures that will break on schema changes
- Unresolved debt: Hardcoded processing fixtures (logged in debt.md)

### Wish I'd Known
1. Adding fields to processing schema breaks 10+ hardcoded fixtures across BookDetails.test.tsx and ProcessingSettingsSection.test.tsx — plan this as a distinct module in TDD
2. `minFreeSpaceGB: 0` is the pattern for skipping disk space checks in import service tests — without it, you need to mock statfs
3. `as Function` callback casts fail the `no-unsafe-function-type` lint rule — use `as (...args: unknown[]) => void` from the start

## #341 Per-Section Save for General Settings — 2026-03-12
**Skill path:** /implement → /claim (manual) → /plan (skipped - prior work) → /handoff
**Outcome:** success — PR #347

### Metrics
- Files changed: 16 | Tests added/modified: 11
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (Import/Search tests still had old props-based pattern; also conditional save button tests needed updating)
- Context compactions: 0

### Workflow experience
- What went smoothly: The prior implementation was mostly complete — 6 commits already on branch. Just needed to fix 2 test files and add design polish (conditional save button rendering).
- Friction / issues encountered: claim.ts failed because branch already existed from prior attempt — had to manually checkout. Self-review and coverage review subagents ran against wrong branch (#285) after an accidental branch switch mid-conversation, wasting tokens.

### Token efficiency
- Highest-token actions: Self-review and coverage review subagents (ran against wrong branch, results were mostly irrelevant)
- Avoidable waste: Branch context switch happened silently — the system-reminders showed file diffs from the #285 branch. Could have caught this earlier by checking `git branch --show-current` before launching subagents.
- Suggestions: Always verify branch before launching expensive subagents. The claim.ts failure left us on the wrong branch.

### Infrastructure gaps
- Repeated workarounds: Manual branch checkout when claim.ts can't handle existing branches
- Missing tooling / config: claim.ts --resume flag for picking up where a prior attempt left off
- Unresolved debt: claim.ts doesn't handle existing branches gracefully

### Wish I'd Known
1. The branch already existed with 6 implementation commits — checking `git log` first would have saved the claim attempt and revealed the scope of remaining work immediately
2. DEFAULT_SETTINGS.search.enabled defaults to `true`, not `false` — this caused subtle test timing issues where assertions hit default values before the useEffect reset
3. Conditional save button rendering (`{isDirty && ...}`) breaks all tests that used `fireEvent.submit(button.closest('form'))` to bypass isDirty — they need to make forms dirty first

## #285 Import Lists — Audiobookshelf, NYT Bestsellers, Hardcover — 2026-03-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #346

### Metrics
- Files changed: ~30 | Tests added/modified: ~50 tests across 8 test files
- Quality gate runs: 2 (pass on attempt 2 — first failed on lint complexity + stale test counts)
- Fix iterations: 3 (lint complexity extraction, job/app test count updates, preview schema bug)
- Context compactions: 1 (caused continuation session, lost some file-read context)

### Workflow experience
- What went smoothly: Module-by-module TDD worked well for this scope. Committing per-module gave clear git history and recovery points. MSW mocking for HTTP providers was clean.
- Friction / issues encountered: Context compaction mid-implementation (8 modules is a lot for one session). The continuation summary needed manual assembly. ConfirmModal props mismatch was caught by self-review but could have been caught earlier by reading the component before using it. Form labels without htmlFor broke getByLabelText tests.

### Token efficiency
- Highest-token actions: Self-review and coverage review subagents (~70K tokens each), frontend test debugging (multiple read/run cycles)
- Avoidable waste: Could have read ConfirmModal.tsx props before writing the delete modal JSX. Could have checked existing job/app test counts before committing.
- Suggestions: For large features, read all interface/type files upfront before writing implementations to avoid prop mismatches.

### Infrastructure gaps
- Repeated workarounds: drizzle-kit broken on Windows (manual migration SQL again)
- Missing tooling / config: No automated check for stale test counts when adding new jobs/routes
- Unresolved debt: Form labels lack htmlFor (accessibility), preview schema was reusing create schema

### Wish I'd Known
1. ConfirmModal requires `isOpen` prop — conditional render wrapping doesn't work because the component returns null when isOpen is falsy. Read component interfaces before using them.
2. Preview/test-config endpoints need their own schema, not the create schema. Route tests that send the full payload mask the bug — test with minimal payloads.
3. Adding a new cron job requires updating test count assertions in `jobs/index.test.ts` AND adding the mock export to the `App.test.tsx` settings mock.

## #339 Harden Flaky Frontend Tests — waitFor and Number Input Patterns — 2026-03-11
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #345

### Metrics
- Files changed: 17 | Tests added/modified: 0 new, ~40+ assertions wrapped in waitFor
- Quality gate runs: 2 (pass on attempt 2 — first failed on unused `user` variables)
- Fix iterations: 1 (lint fix for unused variables left by agents after fireEvent.change conversion)
- Context compactions: 3 (caused full restart of implementation twice)

### Workflow experience
- What went smoothly: Parallelizing agent work across 3 batches was effective — 9 files fixed simultaneously
- Friction / issues encountered: Context compactions across 3 sessions caused full rework twice. Agent work was lost between sessions (clean git status on re-entry). Linter auto-fix hook modified LibraryPage.test.tsx after checkout, requiring an extra commit.

### Token efficiency
- Highest-token actions: Reading all 17 test files to identify Pattern A violations; re-reading files after context compaction
- Avoidable waste: Two full restarts due to context compaction losing uncommitted agent work. Should commit agent results immediately rather than batching.
- Suggestions: For mechanical bulk-edit issues, commit each agent batch immediately instead of accumulating uncommitted changes across the session.

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No mechanism to persist agent edits across context compactions — agents write to working tree but nothing survives session loss
- Unresolved debt: None introduced

### Wish I'd Known
1. **Commit agent work immediately.** Background agents write to the working tree, and context compactions lose track of uncommitted changes. Commit each agent batch as soon as it completes.
2. **Agents leave unused variables.** When converting `userEvent.clear+type` to `fireEvent.change`, agents consistently leave behind `const user = userEvent.setup()`. Include explicit cleanup instructions in the agent prompt.
3. **Not all spec-listed files have violations.** AuthorPage and BackupScheduleForm were listed in scope but had zero Pattern A/B violations. Always verify assertion types against the actual spec criteria before editing.

## #342 Add dropdown clipped by adjacent search result card — 2026-03-11
**Skill path:** /elaborate → /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #344

### Metrics
- Files changed: 2 | Tests added/modified: 9 new, 11 unchanged
- Quality gate runs: 2 (pass on attempt 2 — first blocked by pre-existing metrics.ts lint errors)
- Fix iterations: 1 (test selector fix — `/add/i` matched both trigger and portal button)
- Context compactions: 0

### Workflow experience
- What went smoothly: Single-file bug fix with clear root cause. Portal pattern was straightforward. All 50 caller regression tests passed without modification.
- Friction / issues encountered: Started implementation on wrong branch (#341 instead of #342) — had to stash and switch. Pre-existing lint errors in `scripts/metrics.ts` blocked verify — had to fix those too (main got the fix separately, causing a rebase conflict resolved with `--skip`). Gitea CLI env vars (`GITEA_URL`, `GITEA_OWNER`, `GITEA_REPO`) weren't in `.env` file, requiring manual export.

### Token efficiency
- Highest-token actions: Explore subagents for elaboration and self-review (each ~50-60k tokens)
- Avoidable waste: Elaborate + respond-to-spec-review happened in same conversation as implement, consuming context that could have been separate
- Suggestions: For simple bugs with clear root cause, skip elaborate and go straight to /implement

### Infrastructure gaps
- Repeated workarounds: GITEA env vars missing from .env — had to export manually each time
- Missing tooling / config: verify.ts doesn't distinguish pre-existing lint errors from new ones — a file-scoped lint check would prevent false blocks
- Unresolved debt: None introduced

### Wish I'd Known
1. `backdrop-blur-xl` creates stacking contexts — this is the root cause, not overflow:hidden (see `backdrop-blur-stacking-context.md`)
2. Portal breaks `ref.contains()` for outside-click — need dual refs (see `portal-dual-ref-click-handling.md`)
3. Test selectors with `/add/i` match both "Add" trigger and "Add to Library" portal button — use `/^add$/i` for exact match

## #315 Encrypt secrets at rest (API keys, proxy auth, client passwords) — 2026-03-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #343

### Metrics
- Files changed: 20 | Tests added/modified: 12
- Quality gate runs: 3 (pass on attempt 3)
- Fix iterations: 4 (key init in tests, adapter decryption, SettingsCategory type mismatch, accidental file commit)
- Context compactions: 2 (caused branch switch — had to re-checkout correct branch)

### Workflow experience
- What went smoothly: Secret codec module and migration were clean TDD. Service integration followed a clear pattern across all 5 services.
- Friction / issues encountered: Cross-cutting encryption required updating every service test file (key init). The `getAdapter()` decryption bug was subtle — encrypted API keys were sent in HTTP requests. SettingsCategory type mismatch (`prowlarr`/`auth` aren't SettingsCategory values) required understanding the split between SettingsService and dedicated services. Context compaction switched branches silently.

### Token efficiency
- Highest-token actions: Coverage review subagent (131K tokens), self-review subagent (37K tokens)
- Avoidable waste: Self-review subagent ran on wrong branch after compaction — wasted a full agent run. Coverage review agent missed existing test files (secret-codec.test.ts, secret-migration.test.ts) and reported false negatives.
- Suggestions: Verify branch before launching subagents. Consider lighter-weight self-review for encryption-focused changes.

### Infrastructure gaps
- Repeated workarounds: scripts/metrics.ts has pre-existing unused imports requiring suppression on every branch that touches it
- Missing tooling / config: No test helper to auto-init encryption key — every test file must manually call initializeKey/resetKey
- Unresolved debt: Key rotation CLI deferred, scripts/metrics.ts unused imports

### Wish I'd Known
1. `SettingsCategory` and `SecretEntity` are different type domains — prowlarr/auth are entities but not settings categories. Would have avoided the typecheck failure. (see `settings-category-vs-entity-types.md`)
2. `getAdapter()` is the critical choke point for decryption — every search/poll/test path flows through it. Should have been the first thing to audit. (see `adapter-decryption-trap.md`)
3. Adding a module-level singleton (`initializeKey`) creates a blast radius across ALL test files, not just the ones you modify. Budget 30% of test time for this. (see `encryption-key-init-test-blast-radius.md`)

## #329 Upgrade to Latest Package Versions — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #340

### Metrics
- Files changed: 18 | Tests added/modified: 12 (type fixes only, no new tests)
- Quality gate runs: 1 (pass on attempt 1)
- Fix iterations: 3 (Vitest 4 type errors across 7 files, constructor mock syntax, environmentMatchGlobs removal)
- Context compactions: 1 (caused continuation from summary — no rework needed)

### Workflow experience
- What went smoothly: Phased upgrade approach isolated breakage perfectly — each major version bump was a clean commit. Drizzle, node-cron, Fastify plugins, and Tailwind all upgraded cleanly.
- Friction / issues encountered: Vitest 4 had the most widespread breakage — Mock type changes, vi.spyOn cast changes, constructor mock syntax, and environmentMatchGlobs removal. Each required discovering the fix through trial and error since Vitest 4 migration docs don't cover all edge cases. Context compaction mid-Vitest-fix phase required reading summary to continue.

### Token efficiency
- Highest-token actions: Vitest 4 type fixes — iterative typecheck → fix → typecheck cycles across 7+ test files
- Avoidable waste: Could have searched for all `vi.spyOn(x as never` and `mockImplementation(() =>` patterns upfront instead of fixing file by file
- Suggestions: For major version upgrades, grep for all known breaking patterns before starting fixes

### Infrastructure gaps
- Repeated workarounds: `as any` with eslint-disable for vi.spyOn on private methods — no clean Vitest 4 alternative exists
- Missing tooling / config: No automated migration tooling for Vitest environmentMatchGlobs → projects
- Unresolved debt: tailwind-merge unused in codebase, eslint-plugin-react-hooks blocks ESLint 10

### Wish I'd Known
1. Vitest 4's `environmentMatchGlobs` removal causes ALL client tests to silently fail with "document is not defined" — the environment shows `0ms` instead of an error. Check environment timing in test output.
2. Arrow function constructor mocks (`mockImplementation(() => obj)`) can't be used with `new` in Vitest 4 — must use `function()` syntax. The error message ("not a constructor") doesn't mention Vitest at all.
3. Import `Mock` type from `vitest` not `@vitest/spy` — the internal package isn't directly importable even though TypeScript infers types from it.

## #175 Dockerfile and Docker image build pipeline — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #338

### Metrics
- Files changed: 5 | Tests added/modified: 15 new tests in docker/docker-workflow.test.ts
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (self-review caught weak smoke test assertions + unused env var)
- Context compactions: 0

### Workflow experience
- What went smoothly: Pure infra issue with no app code changes — straightforward workflow YAML + config file updates. Existing Docker test patterns (healthcheck.test.ts, s6-service.test.ts) provided clear precedent for structural file assertions.
- Friction / issues encountered: The elaborate/spec-review cycle was heavy for what ended up being a single YAML file + 3 config updates. Two rounds of spec review before the spec was ready.

### Token efficiency
- Highest-token actions: Explore subagent for elaboration (read many files to discover most of the work was already done from #284/#292)
- Avoidable waste: The elaborate step could have been shorter if it had quickly checked for existing Docker files first before doing full codebase analysis
- Suggestions: For infra issues, check for existing artifacts early to scope down fast

### Infrastructure gaps
- Repeated workarounds: none
- Missing tooling / config: No js-yaml dependency, so YAML tests use string matching (acceptable for now)
- Unresolved debt: Quality-gates job duplicated between ci.yaml and docker.yaml (Gitea doesn't support reusable workflows)

### Wish I'd Known
1. Most of this issue was already shipped — Dockerfile, compose, s6, health checks all existed from #284/#292. The spec title was misleading; it was really "add CI publish pipeline."
2. Gitea Actions doesn't support reusable workflows, so the quality-gates job had to be fully duplicated in docker.yaml.
3. No js-yaml in the project — YAML structure tests need string matching, which is fine for workflow files but would be fragile for deeply nested configs.

## #331 Recycling Bin — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #337

### Metrics
- Files changed: 18 | Tests added/modified: 54
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 3 (queue-based mock ordering, metadata-only restore bug from self-review, missing coverage for partial failure + purge error toasts)
- Context compactions: 1 (required session continuation)

### Workflow experience
- What went smoothly: TDD cycle worked well — service tests caught real bugs early. Self-review caught metadata-only restore path bug before it reached review.
- Friction / issues encountered: Context ran out during handoff phase, requiring a continuation session. Queue-based Drizzle mock pattern was tricky for multi-step operations — had to refactor from beforeEach to per-test helpers. Coverage review caught 2 genuinely missing tests.

### Token efficiency
- Highest-token actions: Service test file with 26 tests consumed significant context with queue mock setup. Coverage review subagent ran twice (once per handoff attempt).
- Avoidable waste: Could have written the partial failure and purge error tests during initial UI test implementation instead of needing a coverage review to catch them.
- Suggestions: When writing mutation tests, always test success + error + edge case (partial failure) in the first pass.

### Infrastructure gaps
- Repeated workarounds: ConfirmModal button selection in tests still relies on DOM index rather than accessible names
- Missing tooling / config: No test helper for ConfirmModal interaction (click confirm/cancel)
- Unresolved debt: Concurrent restore race condition noted in debt.md

### Wish I'd Known
1. Queue-based Drizzle mocks need per-test setup, not beforeEach — multi-step flows consume queue entries in unpredictable order when setup is shared
2. Always check "what happens when string fields are empty vs null" during self-review — `path: ''` vs `path: null` have very different semantics downstream
3. Coverage review will catch missing error/edge case toast tests — better to write success/error/edge triple upfront for every mutation

## #279 System and Health Dashboard — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #336

### Metrics
- Files changed: 20+ | Tests added/modified: 65+
- Quality gate runs: 3 (pass on attempt 1 each time, but re-ran after bug fixes)
- Fix iterations: 3 (lint max-lines extraction, self-review wiring bugs, progressUpdatedAt conditional update)
- Context compactions: 2 (large issue with 9 modules)

### Workflow experience
- What went smoothly: Red/green TDD per module was efficient — each module was self-contained and tests caught issues early. The existing patterns (mock services proxy, renderWithProviders) made frontend testing fast.
- Friction / issues encountered: Self-review caught 2 critical integration bugs (health job never called, task registry never populated) that unit tests couldn't catch because each module was tested in isolation. The route file hit lint max-lines requiring extraction mid-implementation. Context compactions lost state requiring careful reconstruction.

### Token efficiency
- Highest-token actions: HealthCheckService tests (25+ tests with complex mocking), coverage review subagent (read all files exhaustively)
- Avoidable waste: Could have wired jobs/index.ts immediately when implementing Module 4 (health check job) instead of discovering the gap in self-review
- Suggestions: Wire integration points as you go, not as a separate step. Check "is this new thing actually called?" immediately after creating it.

### Infrastructure gaps
- Repeated workarounds: Drizzle libsql API doesn't expose `.get()` on db object — had to use `db.run()` with positional row access. This pattern will recur for any new pragma/raw SQL queries.
- Missing tooling / config: No integration test that verifies all jobs are registered at startup. A startup smoke test would catch wiring gaps.
- Unresolved debt: TaskRegistry.estimateNextRun() is a rough approximation; version hardcoded in system info route.

### Wish I'd Known
1. `db.run()` returns `ResultSet` with `.rows` as arrays of arrays (not objects) — spent time debugging `.get()` which doesn't exist on the db object
2. Always wire new services into `startJobs()` / bootstrap immediately when creating them, not as a separate step — isolation between modules means unit tests can't catch wiring gaps
3. Boundary tests with `Date.now()` need a time buffer — even 1ms of execution time makes "exactly at threshold" tests flaky

## #333 Update Version Check — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #335

### Metrics
- Files changed: 16 | Tests added/modified: 5 test files (37+ tests)
- Quality gate runs: 4 (pass on attempt 4 — typecheck errors from settings type mismatch and unused param)
- Fix iterations: 3 (unused settingsService param, Partial<Settings> vs UpdateSettingsInput, settings.update vs get+set for single-field update)
- Context compactions: 1 (required session continuation, summary preserved full context)

### Workflow experience
- What went smoothly: Spec was well-defined after 2 review rounds. Version helper extraction from prowlarr-compat was clean. In-memory cache + DB-backed dismiss split made testing straightforward. Frontend design pass integrated naturally.
- Friction / issues encountered: `SettingsService.update()` doesn't deep-merge — it overwrites entire categories. Updating a single field (`dismissedUpdateVersion`) required changing from `update({system: {...}})` to `get('system')` + spread + `set('system', merged)`. This cascaded through 3 verify attempts.

### Token efficiency
- Highest-token actions: Context compaction recovery (re-reading files), self-review and coverage review subagents
- Avoidable waste: Could have checked the `SettingsService.update()` signature before writing the dismiss route — would have avoided 2 verify iterations
- Suggestions: Always read the service method signature before calling it in a new route

### Infrastructure gaps
- Repeated workarounds: Settings single-field update requires manual get+spread+set pattern (no patch method)
- Missing tooling / config: api-collision.test.ts missing backupsApi module
- Unresolved debt: SettingsService needs a `patch(category, partialFields)` method — logged in debt.md

### Wish I'd Known
1. `SettingsService.update()` calls `set()` per category which OVERWRITES the full value — updating one field clobbers others unless you get+spread+set manually (see `settings-update-partial-vs-full.md`)
2. Module-level `let` caches persist across Vitest test cases — always export a `_reset()` for test cleanup (see `module-level-cache-test-pollution.md`)
3. The `UpdateSettingsInput` type exists for body validation but the service doesn't use it — there's a type/behavior mismatch between the schema layer and the service layer

## #332 DB Housekeeping Job — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #334

### Metrics
- Files changed: 17 | Tests added/modified: 28
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (self-review caught dead blacklist-cleanup files not deleted)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean implementation path — spec was well-defined after 3 review rounds, settings blast radius was called out in advance so no surprise test failures
- Friction / issues encountered: Multiple spec review rounds (4 comments) before the spec was approved — two concurrent reviews caused a race condition where one saw the timestamp fix and one didn't

### Token efficiency
- Highest-token actions: Spec review response cycles (3 rounds before approval)
- Avoidable waste: The concurrent spec reviews wasted a round — sequential would've been cleaner
- Suggestions: Self-review subagent caught the dead file issue, proving its value — don't skip it

### Infrastructure gaps
- Repeated workarounds: Settings test fixtures need manual updates in ~9 files when adding a field — a centralized test settings factory would reduce this
- Missing tooling / config: None
- Unresolved debt: GeneralSettings probeFfmpeg untested during form submission (pre-existing, logged to debt.md)

### Wish I'd Known
1. Settings blast radius is real — 9 test files needed updating for one new field. The spec review flagged this but the actual grep/fix took time. A shared test helper for settings forms would help. (see `settings-blast-radius-pattern.md`)
2. Consolidating jobs changes their schedule — blacklist cleanup went from daily to weekly. Always verify the original schedule matters for correctness. (see `blacklist-cleanup-frequency-change.md`)
3. Always `git rm` old files when consolidating, not just removing imports — self-review caught dead code. (see `dead-code-after-consolidation.md`)

## #280 Backup and Restore System — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #330

### Metrics
- Files changed: 18 | Tests added/modified: 6 test files, 40+ tests
- Quality gate runs: 2 (pass on attempt 2 — first had lint fixes for unused imports and return-await)
- Fix iterations: 3 (unused TrashIcon import, max-lines-per-function extraction, return-await in catch blocks)
- Context compactions: 1 (required session continuation)

### Workflow experience
- What went smoothly: Startup swap pattern was well-defined in spec, settings registry auto-derives types cleanly, SettingsSection component made the UI consistent with other settings pages
- Friction / issues encountered: `fetchApi()` forces JSON Content-Type — had to use raw `fetch()` for multipart restore upload. `return-await` eslint rule has nuanced behavior (required in try blocks, forbidden in catch blocks). BackupTable extraction was forced by max-lines-per-function rule mid-implementation. Mock typing in tests required `as unknown as Type` double-cast pattern.

### Token efficiency
- Highest-token actions: Coverage review subagent + self-review subagent consumed significant context. Test implementation across 6 files was the bulk of implementation work.
- Avoidable waste: The coverage review flagged some items that were already tested but not recognized. Could have run verify earlier to catch lint issues before the full review cycle.
- Suggestions: Run `pnpm lint` after each major code batch to catch return-await and max-lines early, rather than discovering them at verify time.

### Infrastructure gaps
- Repeated workarounds: `as unknown as Type` double-cast for mocking services in tests — no shared mock factory
- Missing tooling / config: No helper for multipart uploads in the API client layer
- Unresolved debt: system.ts route file growing, no backup encryption, in-memory pending restore state — logged in debt.md

### Wish I'd Known
1. `fetchApi()` auto-sets `Content-Type: application/json` — multipart uploads MUST bypass it and use raw `fetch()` with FormData (see `multipart-upload-skip-fetchapi.md`)
2. SQLite DB replacement while libSQL holds a connection is unsafe — the startup swap pattern (stage file, exit, swap on boot before DB open) is the only safe approach (see `startup-swap-restore-pattern.md`)
3. The `return-await` eslint rule has three contexts: required inside try blocks, forbidden in catch blocks, forbidden at function end — getting this wrong causes lint failures that aren't obvious from the error message

## #282 UI Enhancements — Table View, Filters, Bulk Actions, Pending Review UX — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #328

### Metrics
- Files changed: 28 | Tests added/modified: 95+
- Quality gate runs: 4 (pass on attempt 1, then test stub implementations needed 2 more lint fixes)
- Fix iterations: 3 (eslint complexity in helpers.ts, max-lines in books.ts and LibraryPage.tsx)
- Context compactions: 1 (required session continuation)

### Workflow experience
- What went smoothly: Component extraction pattern (ViewToggle, LibraryModals) cleanly resolved lint limits. The fieldExtractors lookup map pattern elegantly solved complexity lint rule.
- Friction / issues encountered: ESLint complexity rule counts switch cases individually, so a sort-field switch with 8 cases hit 18 vs max 15. Required converting to a Record lookup map. Also, moving approve/reject buttons behind an expand toggle broke 8 tests across 2 files that expected those buttons to be immediately visible.

### Token efficiency
- Highest-token actions: Test stub implementation (7 test files, 95+ tests) consumed significant context across multiple parallel agents
- Avoidable waste: The coverage review agent flagged 14 "untested" items, most of which were either pre-existing or already tested by earlier agents. Could skip re-scanning test files that agents just wrote.
- Suggestions: When agents implement test stubs, skip the exhaustive coverage review — the stubs themselves define the coverage contract

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No auto-detection of pre-existing vs new behaviors in coverage review
- Unresolved debt: `matchesStatusFilter()` doesn't handle 'failed' status — logged in debt.md

### Wish I'd Known
1. ESLint complexity counts each switch case — use lookup maps for field dispatch (see `eslint-complexity-lookup-map.md`)
2. Moving UI elements behind expand/collapse breaks ALL upstream tests that interact with those elements — run full test suite early after such refactors (see `pending-review-expand-test-pattern.md`)
3. Route files are already at max-lines — always extract new route handlers into standalone functions (see `max-lines-route-extraction.md`)

## #283 Real-Time Updates via SSE — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #327

### Metrics
- Files changed: 16 | Tests added/modified: 4 files (44 new tests)
- Quality gate runs: 3 (pass on attempt 3 — lint, type, and import path fixes needed)
- Fix iterations: 2 (import path typo, Drizzle type incompatibility with Zod enum)
- Context compactions: 1 (session continued from prior context)

### Workflow experience
- What went smoothly: The data-driven architecture (CACHE_INVALIDATION_MATRIX, TOAST_EVENT_CONFIG) paid off — no switch statements, clean extension point. Fire-and-forget pattern with `broadcaster?.emit()` kept existing tests working without changes.
- Friction / issues encountered: (1) EventSource API doesn't support cookies — needed SSEProvider to fetch API key. (2) Drizzle's `$inferSelect` type for enum columns isn't assignable to Zod `z.enum()` — had to widen to `z.string()`. (3) Fastify inject() hangs on SSE endpoints — had to test route handler directly.

### Token efficiency
- Highest-token actions: Reading all mutation sites across 4 services + monitor.ts (each 300-500 lines), coverage review subagent (returned false positives)
- Avoidable waste: Coverage review subagent reported 32 "untested behaviors" but most were false positives — it didn't read the actual test files
- Suggestions: For future coverage reviews, explicitly list test file paths for the subagent to read

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No `@/` alias for `src/shared/` — client code must use relative paths to import shared schemas
- Unresolved debt: QualityGateService needs max-lines eslint override (535 lines with SSE emissions)

### Wish I'd Known
1. EventSource API doesn't support `credentials: 'include'` — the `?apikey=` query param fallback was already in the auth plugin but not obvious until implementation (see `eventsource-auth-cookies.md`)
2. Drizzle inferred types and Zod enums don't mix — use `z.string()` for informational fields to avoid type gymnastics (see `drizzle-inferred-types-sse.md`)
3. Fastify inject() blocks forever on hijacked responses — test SSE handlers directly, not through inject (see `fastify-sse-hijack-testing.md`)

## #292 linuxserver.io Compatibility — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #326

### Metrics
- Files changed: 10 (3 new, 2 deleted, 5 modified) | Tests added/modified: 2 files (17 new tests + 1 updated)
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean infrastructure-only change. No app code modifications needed. s6-overlay integration was straightforward — create service files, swap base image, remove custom entrypoint.
- Friction / issues encountered: Spec review took 2 rounds to get right — LSIO's abc user remap model and PUID=0 behavior needed correction. The elaborate/review-spec cycle caught real factual errors about how LSIO init works.

### Token efficiency
- Highest-token actions: Spec review response rounds (reading full comments, updating issue body, writing learnings)
- Avoidable waste: The elaborate phase explored extensively despite this being a well-defined infrastructure task
- Suggestions: For infrastructure-only issues (Dockerfile, CI), the explore phase could be shorter since there's less code interaction to analyze

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No Docker build/run in CI to actually validate the LSIO image builds and starts correctly
- Unresolved debt: Multi-arch Docker CI still missing (from #284)

### Wish I'd Known
1. LSIO base images use `s6-setuidgid abc` in service run scripts — the abc user is pre-created and remapped, not created at runtime like the old entrypoint approach
2. LSIO base doesn't include Node.js — must install via apk (not obvious from the spec alone)
3. No ENTRYPOINT should be set — LSIO s6-overlay IS the entrypoint and handles all init/supervision

## #284 Deployment Enhancements — ARM64, PUID/PGID, URL Base — 2026-03-09
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #325

### Metrics
- Files changed: ~25 | Tests added/modified: 4 test files (21 new tests)
- Quality gate runs: 4 (pass on attempt 4 — lint complexity, test failures, coverage gate, coverage gate again)
- Fix iterations: 4 (complexity extraction, test registration timing, server-utils extraction, entry point exclusion)
- Context compactions: 1 (session resumed from compacted context)

### Workflow experience
- What went smoothly: Config parsing, auth plugin URL_BASE integration, frontend injection pattern, cover URL utility, Dockerfile/entrypoint
- Friction / issues encountered: Coverage gate was the main pain point — V8 coverage includes all loaded files regardless of vitest exclude config, so entry points with side effects (index.ts, main.tsx) showed 0% even when excluded. Required extracting helpers to separate module AND adding entry point exclusion to verify.ts.

### Token efficiency
- Highest-token actions: Coverage review subagent (overly broad — reviewed ALL behaviors in changed files, not just new ones; many false positives). Self-review subagent was more focused.
- Avoidable waste: Could have anticipated the complexity/coverage issues earlier by checking lint and coverage before committing all changes.
- Suggestions: Run `pnpm lint` after each significant code change to catch complexity violations early. Check coverage implications before modifying entry point files.

### Infrastructure gaps
- Repeated workarounds: V8 coverage JSON includes excluded files — had to add entry point exclusion to both vitest.config.ts AND verify.ts
- Missing tooling / config: No CI/CD pipeline for multi-arch Docker builds (docker buildx)
- Unresolved debt: CSP unsafe-inline for config script injection, registerStaticAndSpa untested, multi-arch CI pipeline needed

### Wish I'd Known
1. V8 coverage provider ignores vitest exclude for JSON output — if your verify script reads coverage-summary.json directly, you need a separate exclusion mechanism (see `v8-coverage-includes-all-loaded.md`)
2. Fastify `fp()` plugins propagate to parent scope while scoped routes don't — auth plugin sees full URL including prefix, route handlers see URL without prefix (see `fastify-scoped-prefix-auth-interaction.md`)
3. Routes registered after `app.ready()` don't wire hooks properly — test helpers must accept routes callback before ready (see `fastify-routes-after-ready.md`)

## #271 Blacklist Improvements — Reason Codes and TTL — 2026-03-09
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #321

### Metrics
- Files changed: ~25 | Tests added/modified: ~50+
- Quality gate runs: 3 (pass on attempt 1 after each round of fixes)
- Fix iterations: 3 (settings fixture deep-merge, migration breakpoints, monitor test assertion updates)
- Context compactions: 1 (caused need to re-read files but no rework)

### Workflow experience
- What went smoothly: Schema extension, service layer, route layer, and cleanup job all went cleanly. Test stubs from /plan provided good scaffolding.
- Friction / issues encountered: Wide fixture blast radius — adding `blacklistTtlDays` to search settings broke 12+ test files that partially override settings. Fixed by converting factory to DeepPartial with deep-merge. Also `pnpm db:generate` is broken on Windows (CJS/ESM issue with drizzle-kit), so migration SQL had to be written manually.

### Token efficiency
- Highest-token actions: Wide fixture migration across 12+ test files, monitor.test.ts modifications (large file)
- Avoidable waste: Could have predicted the settings fixture breakage and fixed the factory FIRST before adding the new field
- Suggestions: When adding fields to nested settings schemas, always update the factory's merge strategy first

### Infrastructure gaps
- Repeated workarounds: Manual migration SQL writing due to broken db:generate
- Missing tooling / config: drizzle-kit CJS/ESM fix for Windows
- Unresolved debt: monitor.ts overlapping try/catch patterns

### Wish I'd Known
1. Adding a field to a nested settings category causes a wide blast radius in test fixtures — fix the factory's merge strategy first
2. SQLite ALTER TABLE statements need `--> statement-breakpoint` markers in Drizzle migrations — they can't be combined
3. Optimistic updates for type toggles need careful handling of derived nullable fields (expiresAt) that the server computes

# Workflow Log

## #355 Add Pagination Infrastructure to Unbounded Queries — 2026-03-13
**Skill path:** /elaborate → /respond-to-spec-review (x4) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #373

### Metrics
- Files changed: ~35 | Tests added/modified: ~30
- Quality gate runs: 2 (pass on attempt 2 — lint fix in blacklist route)
- Fix iterations: 1 (blacklist.ts lint: `import type` + `return await`)
- Context compactions: 0

### Workflow experience
- What went smoothly: Service pattern was consistent across all four — once one was done, the rest were mechanical. TanStack Query's `select()` perfectly isolated the envelope unwrapping from component code.
- Friction / issues encountered: 4 rounds of spec review before approval — the core tension (can't enforce limits without pagination UI) took 3 rounds to resolve by rescoping as Phase 1/2. Stale merge conflicts in unrelated test files blocked first commit. mockDbChain missing `offset` method.

### Token efficiency
- Highest-token actions: Spec review rounds (4 rounds), Explore subagent for codebase exploration, batch test mock updates across ~100 sites
- Avoidable waste: The 4-round spec review cycle could have been 1-2 rounds if the original spec had honestly scoped as "infrastructure only" from the start
- Suggestions: When a spec says "add X to Y" but Y's consumers can't handle X without UI changes, scope as infrastructure-only immediately rather than iterating toward that conclusion

### Infrastructure gaps
- Repeated workarounds: Stale merge conflict markers from unrelated stashes blocking commits on every branch
- Missing tooling / config: mockDbChain should auto-generate all Drizzle chainable methods rather than maintaining a manual list
- Unresolved debt: BookService slim select uses explicit column list that must sync with schema

### Wish I'd Known
1. The fundamental tension between "bound queries" and "no pagination UI" would dominate spec review — should have scoped as Phase 1 infrastructure from the start
2. Response shape changes (array → envelope) have ~30-file blast radius — count callers before committing to the approach
3. TanStack Query's `query.state.data` in callbacks is always raw (pre-select), not the transformed value — this distinction matters for refetchInterval logic

## #357 Refactor Search Pipeline — Deduplicate search-and-grab loop, extract from routes — 2026-03-13
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #371

### Metrics
- Files changed: 10 | Tests added/modified: 2 (search-pipeline.test.ts new, search.test.ts updated)
- Quality gate runs: 2 (pass on attempt 2 — lint errors on first run)
- Fix iterations: 1 (lint: `import()` type annotation and unused import)
- Context compactions: 0

### Workflow experience
- What went smoothly: The extraction was clean — functions moved with no signature changes, tests moved with only import path updates. The 5-module plan worked well for a refactoring issue.
- Friction / issues encountered: Pre-existing merge conflicts in `ImportSettingsSection.test.tsx` and `SearchSettingsSection.test.tsx` blocked the first commit. Had to resolve them before any commit could proceed. Also, the `searched++` counter semantics changed subtly when deduplicating — the old code incremented after `searchAll` but before `grab`, so grab failures still counted. After extraction, grab failures throw and the counter doesn't increment. Required a test assertion update.

### Token efficiency
- Highest-token actions: Explore subagent for self-review and coverage review (both thorough)
- Avoidable waste: The spec review went 3 rounds (elaborate → respond → respond) before approval; most findings were from the initial elaboration not reading source carefully enough
- Suggestions: For deduplication issues, the elaboration subagent should independently grep for ALL instances of the pattern, not just validate what the spec names

### Infrastructure gaps
- Repeated workarounds: Pre-existing merge conflicts from stash required manual resolution on every new branch. `claim.ts` should detect and warn about UU files.
- Missing tooling / config: No automated merge conflict detection in `claim.ts`
- Unresolved debt: `runUpgradeSearchJob` still has its own loop (different enough to not fit `searchAndGrabForBook`); `jobs/search.ts` re-exports from `search-pipeline.ts` for backward compat

### Wish I'd Known
1. Pre-existing merge conflicts in settings test files would block ALL commits — should have resolved them immediately after `claim.ts` ran
2. The `searched` counter increment position between search and grab means deduplication changes counter semantics — always check counter placement relative to extracted boundaries
3. `runUpgradeSearchJob` has enough additional logic (quality comparison, double grab-floor check) that it can't simply call `searchAndGrabForBook` — it needed to stay as its own loop with only `buildSearchQuery` deduplication

## #358 API Naming Convention & Collision Guard Completeness — 2026-03-13
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #370

### Metrics
- Files changed: 29 | Tests added/modified: 10
- Quality gate runs: 3 (pass on attempt 3 — coverage gate caught missing useEventHistory.test.ts)
- Fix iterations: 3 (merge conflict resolution, replace_all overshoot on `logout`, coverage gate)
- Context compactions: 0

### Workflow experience
- What went smoothly: TypeScript strict mode made rename verification trivial — `pnpm typecheck` caught every missed caller
- Friction / issues encountered: Pre-existing merge conflicts in SearchSettingsSection.test.tsx and ImportSettingsSection.test.tsx blocked lint/verify. `git checkout --theirs` resolved the import line but left deeper conflicts. Settings test files from the stashed version assumed Save button always visible, but the component conditionally renders it only when `isDirty`. `replace_all` for `logout` was too aggressive — renamed hook's public API method alongside the internal API call.

### Token efficiency
- Highest-token actions: Reading all test files to understand mock patterns, self-review subagent
- Avoidable waste: Could have used targeted grep-based edits for test file renames instead of reading full files
- Suggestions: For mechanical rename refactors, batch the renames by grepping for all call sites first, then edit in parallel

### Infrastructure gaps
- Repeated workarounds: Pre-existing merge conflicts from stale stashes (same issue as #362 debt item)
- Missing tooling: `claim.ts` doesn't check for unmerged files before creating branches (existing debt item)
- Unresolved debt: CredentialsSection lacks dedicated test file (discovered, logged to debt.md)

### Wish I'd Known
1. TanStack Query prefix-matching semantics for `invalidateQueries` — `['eventHistory']` is broader than `['eventHistory', undefined]`. This was caught in spec review but would have been nice to know before writing the spec. (→ `tanstack-query-prefix-key-invalidation.md`)
2. `replace_all` is dangerous for method names shared between API modules and hook return values — `logout` exists on both `api` and `result.current`. (→ `replace-all-overshoot-hook-api.md`)
3. Settings section tests from pre-#362 branch assume Save button is always visible, but post-per-section-save components conditionally render it only when `isDirty`. (→ `merge-conflict-stash-upstream-save-button.md`)

## #362 Test Pattern Cleanup — Replace brittle selectors and fireEvent usage — 2026-03-13
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #369

### Metrics
- Files changed: 20 | Tests added/modified: 0 new, 20 files cleaned up (31 insertions, 38 deletions)
- Quality gate runs: 1 (pass on attempt 1)
- Fix iterations: 2 (number input isDirty constraint discovery, pre-existing merge conflict markers from stale stash)
- Context compactions: 1 (caused continuation session)

### Workflow experience
- What went smoothly: Mechanical replacements were straightforward — `container.innerHTML === ''` → `toBeEmptyDOMElement()`, `.animate-spin` → `getByTestId('loading-spinner')`, CSS class selectors → `getByTestId('modal-backdrop')`, `.previousElementSibling` → `getByRole('checkbox', { name })`. All 20 files passed on first verify run.
- Friction / issues encountered: (1) Pre-existing merge conflict markers from a stale `git stash pop` on main blocked ALL commits on every branch — took investigation to diagnose. (2) Attempted to convert `fireEvent.submit` to `userEvent` interactions on BackupScheduleForm but discovered RHF `valueAsNumber` + jsdom is fundamentally incompatible with making forms dirty through any event mechanism. (3) Context compaction mid-handoff required continuation session.

### Token efficiency
- Highest-token actions: Self-review and coverage review subagents (~60-80K each), M-32 number input exploration (4 failed approaches before confirming constraint)
- Avoidable waste: The M-32 exploration through `user.clear()`, `user.tripleClick()`, `fireEvent.change`, `fireEvent.input` could have been skipped — the learning from #339 already documented this constraint
- Suggestions: Check `.claude/cl/learnings/` for relevant constraints BEFORE attempting workarounds on known-problematic patterns

### Infrastructure gaps
- Repeated workarounds: `fireEvent.submit` for RHF number-input forms (BackupScheduleForm, NetworkSettingsSection) — same workaround documented twice now
- Missing tooling / config: claim.ts doesn't check for unmerged files from stale stashes before creating branches
- Unresolved debt: claim.ts unmerged file check (logged in debt.md)

### Wish I'd Known
1. Pre-existing merge conflict markers from `git stash pop` block ALL commits on every branch — always check `git status` for UU files before starting work (see `stash-conflict-markers-block-commit.md`)
2. The number input + RHF `valueAsNumber` + jsdom constraint was already documented in `number-input-rhf-isdirty-jsdom.md` from #339 — reading learnings upfront would have saved 4 failed approach attempts (see `number-input-rhf-isdirty-jsdom.md`)
3. For mechanical bulk-edit chore issues, the elaborate/spec-review cycle adds more overhead than value — the spec needed 2 review rounds to narrow scope that was obvious from reading the code directly

## #198 Custom post-processing script support — 2026-03-12
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #348

### Metrics
- Files changed: 7 | Tests added/modified: 24 (15 unit, 4 integration, 5 UI)
- Quality gate runs: 3 (pass on attempt 3 — first had lint errors, second had typecheck from unfixed fixtures)
- Fix iterations: 2 (lint: `as Function` → `as (...args: unknown[]) => void` + complexity extraction; typecheck: hardcoded processing fixtures missing new fields)
- Context compactions: 1 (caused need to re-read files but no rework)

### Workflow experience
- What went smoothly: Schema + utility module TDD was clean. Import service integration followed existing tag-embedding pattern perfectly.
- Friction / issues encountered: Settings fixture blast radius was the biggest time sink — 10+ hardcoded processing objects across test files needed updating. The `enabled: true` variants could be batch-replaced but `enabled: false` needed individual handling. Also hit merge conflicts with #341 branch on settings test files (Import/Library/Search sections).

### Token efficiency
- Highest-token actions: Coverage review subagent (92k tokens), self-review subagent (67k tokens)
- Avoidable waste: Could have planned the fixture blast radius as a distinct module upfront instead of discovering it during verify
- Suggestions: For settings schema changes, always grep for hardcoded fixtures before starting implementation to know the blast radius early

### Infrastructure gaps
- Repeated workarounds: Full processing object overrides in tests (10+ places) — should use partial overrides with createMockSettings()
- Missing tooling / config: No automated detection of hardcoded settings fixtures that will break on schema changes
- Unresolved debt: Hardcoded processing fixtures (logged in debt.md)

### Wish I'd Known
1. Adding fields to processing schema breaks 10+ hardcoded fixtures across BookDetails.test.tsx and ProcessingSettingsSection.test.tsx — plan this as a distinct module in TDD
2. `minFreeSpaceGB: 0` is the pattern for skipping disk space checks in import service tests — without it, you need to mock statfs
3. `as Function` callback casts fail the `no-unsafe-function-type` lint rule — use `as (...args: unknown[]) => void` from the start

## #341 Per-Section Save for General Settings — 2026-03-12
**Skill path:** /implement → /claim (manual) → /plan (skipped - prior work) → /handoff
**Outcome:** success — PR #347

### Metrics
- Files changed: 16 | Tests added/modified: 11
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (Import/Search tests still had old props-based pattern; also conditional save button tests needed updating)
- Context compactions: 0

### Workflow experience
- What went smoothly: The prior implementation was mostly complete — 6 commits already on branch. Just needed to fix 2 test files and add design polish (conditional save button rendering).
- Friction / issues encountered: claim.ts failed because branch already existed from prior attempt — had to manually checkout. Self-review and coverage review subagents ran against wrong branch (#285) after an accidental branch switch mid-conversation, wasting tokens.

### Token efficiency
- Highest-token actions: Self-review and coverage review subagents (ran against wrong branch, results were mostly irrelevant)
- Avoidable waste: Branch context switch happened silently — the system-reminders showed file diffs from the #285 branch. Could have caught this earlier by checking `git branch --show-current` before launching subagents.
- Suggestions: Always verify branch before launching expensive subagents. The claim.ts failure left us on the wrong branch.

### Infrastructure gaps
- Repeated workarounds: Manual branch checkout when claim.ts can't handle existing branches
- Missing tooling / config: claim.ts --resume flag for picking up where a prior attempt left off
- Unresolved debt: claim.ts doesn't handle existing branches gracefully

### Wish I'd Known
1. The branch already existed with 6 implementation commits — checking `git log` first would have saved the claim attempt and revealed the scope of remaining work immediately
2. DEFAULT_SETTINGS.search.enabled defaults to `true`, not `false` — this caused subtle test timing issues where assertions hit default values before the useEffect reset
3. Conditional save button rendering (`{isDirty && ...}`) breaks all tests that used `fireEvent.submit(button.closest('form'))` to bypass isDirty — they need to make forms dirty first

## #285 Import Lists — Audiobookshelf, NYT Bestsellers, Hardcover — 2026-03-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #346

### Metrics
- Files changed: ~30 | Tests added/modified: ~50 tests across 8 test files
- Quality gate runs: 2 (pass on attempt 2 — first failed on lint complexity + stale test counts)
- Fix iterations: 3 (lint complexity extraction, job/app test count updates, preview schema bug)
- Context compactions: 1 (caused continuation session, lost some file-read context)

### Workflow experience
- What went smoothly: Module-by-module TDD worked well for this scope. Committing per-module gave clear git history and recovery points. MSW mocking for HTTP providers was clean.
- Friction / issues encountered: Context compaction mid-implementation (8 modules is a lot for one session). The continuation summary needed manual assembly. ConfirmModal props mismatch was caught by self-review but could have been caught earlier by reading the component before using it. Form labels without htmlFor broke getByLabelText tests.

### Token efficiency
- Highest-token actions: Self-review and coverage review subagents (~70K tokens each), frontend test debugging (multiple read/run cycles)
- Avoidable waste: Could have read ConfirmModal.tsx props before writing the delete modal JSX. Could have checked existing job/app test counts before committing.
- Suggestions: For large features, read all interface/type files upfront before writing implementations to avoid prop mismatches.

### Infrastructure gaps
- Repeated workarounds: drizzle-kit broken on Windows (manual migration SQL again)
- Missing tooling / config: No automated check for stale test counts when adding new jobs/routes
- Unresolved debt: Form labels lack htmlFor (accessibility), preview schema was reusing create schema

### Wish I'd Known
1. ConfirmModal requires `isOpen` prop — conditional render wrapping doesn't work because the component returns null when isOpen is falsy. Read component interfaces before using them.
2. Preview/test-config endpoints need their own schema, not the create schema. Route tests that send the full payload mask the bug — test with minimal payloads.
3. Adding a new cron job requires updating test count assertions in `jobs/index.test.ts` AND adding the mock export to the `App.test.tsx` settings mock.

## #339 Harden Flaky Frontend Tests — waitFor and Number Input Patterns — 2026-03-11
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #345

### Metrics
- Files changed: 17 | Tests added/modified: 0 new, ~40+ assertions wrapped in waitFor
- Quality gate runs: 2 (pass on attempt 2 — first failed on unused `user` variables)
- Fix iterations: 1 (lint fix for unused variables left by agents after fireEvent.change conversion)
- Context compactions: 3 (caused full restart of implementation twice)

### Workflow experience
- What went smoothly: Parallelizing agent work across 3 batches was effective — 9 files fixed simultaneously
- Friction / issues encountered: Context compactions across 3 sessions caused full rework twice. Agent work was lost between sessions (clean git status on re-entry). Linter auto-fix hook modified LibraryPage.test.tsx after checkout, requiring an extra commit.

### Token efficiency
- Highest-token actions: Reading all 17 test files to identify Pattern A violations; re-reading files after context compaction
- Avoidable waste: Two full restarts due to context compaction losing uncommitted agent work. Should commit agent results immediately rather than batching.
- Suggestions: For mechanical bulk-edit issues, commit each agent batch immediately instead of accumulating uncommitted changes across the session.

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No mechanism to persist agent edits across context compactions — agents write to working tree but nothing survives session loss
- Unresolved debt: None introduced

### Wish I'd Known
1. **Commit agent work immediately.** Background agents write to the working tree, and context compactions lose track of uncommitted changes. Commit each agent batch as soon as it completes.
2. **Agents leave unused variables.** When converting `userEvent.clear+type` to `fireEvent.change`, agents consistently leave behind `const user = userEvent.setup()`. Include explicit cleanup instructions in the agent prompt.
3. **Not all spec-listed files have violations.** AuthorPage and BackupScheduleForm were listed in scope but had zero Pattern A/B violations. Always verify assertion types against the actual spec criteria before editing.

## #342 Add dropdown clipped by adjacent search result card — 2026-03-11
**Skill path:** /elaborate → /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #344

### Metrics
- Files changed: 2 | Tests added/modified: 9 new, 11 unchanged
- Quality gate runs: 2 (pass on attempt 2 — first blocked by pre-existing metrics.ts lint errors)
- Fix iterations: 1 (test selector fix — `/add/i` matched both trigger and portal button)
- Context compactions: 0

### Workflow experience
- What went smoothly: Single-file bug fix with clear root cause. Portal pattern was straightforward. All 50 caller regression tests passed without modification.
- Friction / issues encountered: Started implementation on wrong branch (#341 instead of #342) — had to stash and switch. Pre-existing lint errors in `scripts/metrics.ts` blocked verify — had to fix those too (main got the fix separately, causing a rebase conflict resolved with `--skip`). Gitea CLI env vars (`GITEA_URL`, `GITEA_OWNER`, `GITEA_REPO`) weren't in `.env` file, requiring manual export.

### Token efficiency
- Highest-token actions: Explore subagents for elaboration and self-review (each ~50-60k tokens)
- Avoidable waste: Elaborate + respond-to-spec-review happened in same conversation as implement, consuming context that could have been separate
- Suggestions: For simple bugs with clear root cause, skip elaborate and go straight to /implement

### Infrastructure gaps
- Repeated workarounds: GITEA env vars missing from .env — had to export manually each time
- Missing tooling / config: verify.ts doesn't distinguish pre-existing lint errors from new ones — a file-scoped lint check would prevent false blocks
- Unresolved debt: None introduced

### Wish I'd Known
1. `backdrop-blur-xl` creates stacking contexts — this is the root cause, not overflow:hidden (see `backdrop-blur-stacking-context.md`)
2. Portal breaks `ref.contains()` for outside-click — need dual refs (see `portal-dual-ref-click-handling.md`)
3. Test selectors with `/add/i` match both "Add" trigger and "Add to Library" portal button — use `/^add$/i` for exact match

## #315 Encrypt secrets at rest (API keys, proxy auth, client passwords) — 2026-03-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #343

### Metrics
- Files changed: 20 | Tests added/modified: 12
- Quality gate runs: 3 (pass on attempt 3)
- Fix iterations: 4 (key init in tests, adapter decryption, SettingsCategory type mismatch, accidental file commit)
- Context compactions: 2 (caused branch switch — had to re-checkout correct branch)

### Workflow experience
- What went smoothly: Secret codec module and migration were clean TDD. Service integration followed a clear pattern across all 5 services.
- Friction / issues encountered: Cross-cutting encryption required updating every service test file (key init). The `getAdapter()` decryption bug was subtle — encrypted API keys were sent in HTTP requests. SettingsCategory type mismatch (`prowlarr`/`auth` aren't SettingsCategory values) required understanding the split between SettingsService and dedicated services. Context compaction switched branches silently.

### Token efficiency
- Highest-token actions: Coverage review subagent (131K tokens), self-review subagent (37K tokens)
- Avoidable waste: Self-review subagent ran on wrong branch after compaction — wasted a full agent run. Coverage review agent missed existing test files (secret-codec.test.ts, secret-migration.test.ts) and reported false negatives.
- Suggestions: Verify branch before launching subagents. Consider lighter-weight self-review for encryption-focused changes.

### Infrastructure gaps
- Repeated workarounds: scripts/metrics.ts has pre-existing unused imports requiring suppression on every branch that touches it
- Missing tooling / config: No test helper to auto-init encryption key — every test file must manually call initializeKey/resetKey
- Unresolved debt: Key rotation CLI deferred, scripts/metrics.ts unused imports

### Wish I'd Known
1. `SettingsCategory` and `SecretEntity` are different type domains — prowlarr/auth are entities but not settings categories. Would have avoided the typecheck failure. (see `settings-category-vs-entity-types.md`)
2. `getAdapter()` is the critical choke point for decryption — every search/poll/test path flows through it. Should have been the first thing to audit. (see `adapter-decryption-trap.md`)
3. Adding a module-level singleton (`initializeKey`) creates a blast radius across ALL test files, not just the ones you modify. Budget 30% of test time for this. (see `encryption-key-init-test-blast-radius.md`)

## #329 Upgrade to Latest Package Versions — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #340

### Metrics
- Files changed: 18 | Tests added/modified: 12 (type fixes only, no new tests)
- Quality gate runs: 1 (pass on attempt 1)
- Fix iterations: 3 (Vitest 4 type errors across 7 files, constructor mock syntax, environmentMatchGlobs removal)
- Context compactions: 1 (caused continuation from summary — no rework needed)

### Workflow experience
- What went smoothly: Phased upgrade approach isolated breakage perfectly — each major version bump was a clean commit. Drizzle, node-cron, Fastify plugins, and Tailwind all upgraded cleanly.
- Friction / issues encountered: Vitest 4 had the most widespread breakage — Mock type changes, vi.spyOn cast changes, constructor mock syntax, and environmentMatchGlobs removal. Each required discovering the fix through trial and error since Vitest 4 migration docs don't cover all edge cases. Context compaction mid-Vitest-fix phase required reading summary to continue.

### Token efficiency
- Highest-token actions: Vitest 4 type fixes — iterative typecheck → fix → typecheck cycles across 7+ test files
- Avoidable waste: Could have searched for all `vi.spyOn(x as never` and `mockImplementation(() =>` patterns upfront instead of fixing file by file
- Suggestions: For major version upgrades, grep for all known breaking patterns before starting fixes

### Infrastructure gaps
- Repeated workarounds: `as any` with eslint-disable for vi.spyOn on private methods — no clean Vitest 4 alternative exists
- Missing tooling / config: No automated migration tooling for Vitest environmentMatchGlobs → projects
- Unresolved debt: tailwind-merge unused in codebase, eslint-plugin-react-hooks blocks ESLint 10

### Wish I'd Known
1. Vitest 4's `environmentMatchGlobs` removal causes ALL client tests to silently fail with "document is not defined" — the environment shows `0ms` instead of an error. Check environment timing in test output.
2. Arrow function constructor mocks (`mockImplementation(() => obj)`) can't be used with `new` in Vitest 4 — must use `function()` syntax. The error message ("not a constructor") doesn't mention Vitest at all.
3. Import `Mock` type from `vitest` not `@vitest/spy` — the internal package isn't directly importable even though TypeScript infers types from it.

## #175 Dockerfile and Docker image build pipeline — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #338

### Metrics
- Files changed: 5 | Tests added/modified: 15 new tests in docker/docker-workflow.test.ts
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (self-review caught weak smoke test assertions + unused env var)
- Context compactions: 0

### Workflow experience
- What went smoothly: Pure infra issue with no app code changes — straightforward workflow YAML + config file updates. Existing Docker test patterns (healthcheck.test.ts, s6-service.test.ts) provided clear precedent for structural file assertions.
- Friction / issues encountered: The elaborate/spec-review cycle was heavy for what ended up being a single YAML file + 3 config updates. Two rounds of spec review before the spec was ready.

### Token efficiency
- Highest-token actions: Explore subagent for elaboration (read many files to discover most of the work was already done from #284/#292)
- Avoidable waste: The elaborate step could have been shorter if it had quickly checked for existing Docker files first before doing full codebase analysis
- Suggestions: For infra issues, check for existing artifacts early to scope down fast

### Infrastructure gaps
- Repeated workarounds: none
- Missing tooling / config: No js-yaml dependency, so YAML tests use string matching (acceptable for now)
- Unresolved debt: Quality-gates job duplicated between ci.yaml and docker.yaml (Gitea doesn't support reusable workflows)

### Wish I'd Known
1. Most of this issue was already shipped — Dockerfile, compose, s6, health checks all existed from #284/#292. The spec title was misleading; it was really "add CI publish pipeline."
2. Gitea Actions doesn't support reusable workflows, so the quality-gates job had to be fully duplicated in docker.yaml.
3. No js-yaml in the project — YAML structure tests need string matching, which is fine for workflow files but would be fragile for deeply nested configs.

## #331 Recycling Bin — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #337

### Metrics
- Files changed: 18 | Tests added/modified: 54
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 3 (queue-based mock ordering, metadata-only restore bug from self-review, missing coverage for partial failure + purge error toasts)
- Context compactions: 1 (required session continuation)

### Workflow experience
- What went smoothly: TDD cycle worked well — service tests caught real bugs early. Self-review caught metadata-only restore path bug before it reached review.
- Friction / issues encountered: Context ran out during handoff phase, requiring a continuation session. Queue-based Drizzle mock pattern was tricky for multi-step operations — had to refactor from beforeEach to per-test helpers. Coverage review caught 2 genuinely missing tests.

### Token efficiency
- Highest-token actions: Service test file with 26 tests consumed significant context with queue mock setup. Coverage review subagent ran twice (once per handoff attempt).
- Avoidable waste: Could have written the partial failure and purge error tests during initial UI test implementation instead of needing a coverage review to catch them.
- Suggestions: When writing mutation tests, always test success + error + edge case (partial failure) in the first pass.

### Infrastructure gaps
- Repeated workarounds: ConfirmModal button selection in tests still relies on DOM index rather than accessible names
- Missing tooling / config: No test helper for ConfirmModal interaction (click confirm/cancel)
- Unresolved debt: Concurrent restore race condition noted in debt.md

### Wish I'd Known
1. Queue-based Drizzle mocks need per-test setup, not beforeEach — multi-step flows consume queue entries in unpredictable order when setup is shared
2. Always check "what happens when string fields are empty vs null" during self-review — `path: ''` vs `path: null` have very different semantics downstream
3. Coverage review will catch missing error/edge case toast tests — better to write success/error/edge triple upfront for every mutation

## #279 System and Health Dashboard — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #336

### Metrics
- Files changed: 20+ | Tests added/modified: 65+
- Quality gate runs: 3 (pass on attempt 1 each time, but re-ran after bug fixes)
- Fix iterations: 3 (lint max-lines extraction, self-review wiring bugs, progressUpdatedAt conditional update)
- Context compactions: 2 (large issue with 9 modules)

### Workflow experience
- What went smoothly: Red/green TDD per module was efficient — each module was self-contained and tests caught issues early. The existing patterns (mock services proxy, renderWithProviders) made frontend testing fast.
- Friction / issues encountered: Self-review caught 2 critical integration bugs (health job never called, task registry never populated) that unit tests couldn't catch because each module was tested in isolation. The route file hit lint max-lines requiring extraction mid-implementation. Context compactions lost state requiring careful reconstruction.

### Token efficiency
- Highest-token actions: HealthCheckService tests (25+ tests with complex mocking), coverage review subagent (read all files exhaustively)
- Avoidable waste: Could have wired jobs/index.ts immediately when implementing Module 4 (health check job) instead of discovering the gap in self-review
- Suggestions: Wire integration points as you go, not as a separate step. Check "is this new thing actually called?" immediately after creating it.

### Infrastructure gaps
- Repeated workarounds: Drizzle libsql API doesn't expose `.get()` on db object — had to use `db.run()` with positional row access. This pattern will recur for any new pragma/raw SQL queries.
- Missing tooling / config: No integration test that verifies all jobs are registered at startup. A startup smoke test would catch wiring gaps.
- Unresolved debt: TaskRegistry.estimateNextRun() is a rough approximation; version hardcoded in system info route.

### Wish I'd Known
1. `db.run()` returns `ResultSet` with `.rows` as arrays of arrays (not objects) — spent time debugging `.get()` which doesn't exist on the db object
2. Always wire new services into `startJobs()` / bootstrap immediately when creating them, not as a separate step — isolation between modules means unit tests can't catch wiring gaps
3. Boundary tests with `Date.now()` need a time buffer — even 1ms of execution time makes "exactly at threshold" tests flaky

## #333 Update Version Check — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #335

### Metrics
- Files changed: 16 | Tests added/modified: 5 test files (37+ tests)
- Quality gate runs: 4 (pass on attempt 4 — typecheck errors from settings type mismatch and unused param)
- Fix iterations: 3 (unused settingsService param, Partial<Settings> vs UpdateSettingsInput, settings.update vs get+set for single-field update)
- Context compactions: 1 (required session continuation, summary preserved full context)

### Workflow experience
- What went smoothly: Spec was well-defined after 2 review rounds. Version helper extraction from prowlarr-compat was clean. In-memory cache + DB-backed dismiss split made testing straightforward. Frontend design pass integrated naturally.
- Friction / issues encountered: `SettingsService.update()` doesn't deep-merge — it overwrites entire categories. Updating a single field (`dismissedUpdateVersion`) required changing from `update({system: {...}})` to `get('system')` + spread + `set('system', merged)`. This cascaded through 3 verify attempts.

### Token efficiency
- Highest-token actions: Context compaction recovery (re-reading files), self-review and coverage review subagents
- Avoidable waste: Could have checked the `SettingsService.update()` signature before writing the dismiss route — would have avoided 2 verify iterations
- Suggestions: Always read the service method signature before calling it in a new route

### Infrastructure gaps
- Repeated workarounds: Settings single-field update requires manual get+spread+set pattern (no patch method)
- Missing tooling / config: api-collision.test.ts missing backupsApi module
- Unresolved debt: SettingsService needs a `patch(category, partialFields)` method — logged in debt.md

### Wish I'd Known
1. `SettingsService.update()` calls `set()` per category which OVERWRITES the full value — updating one field clobbers others unless you get+spread+set manually (see `settings-update-partial-vs-full.md`)
2. Module-level `let` caches persist across Vitest test cases — always export a `_reset()` for test cleanup (see `module-level-cache-test-pollution.md`)
3. The `UpdateSettingsInput` type exists for body validation but the service doesn't use it — there's a type/behavior mismatch between the schema layer and the service layer

## #332 DB Housekeeping Job — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #334

### Metrics
- Files changed: 17 | Tests added/modified: 28
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (self-review caught dead blacklist-cleanup files not deleted)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean implementation path — spec was well-defined after 3 review rounds, settings blast radius was called out in advance so no surprise test failures
- Friction / issues encountered: Multiple spec review rounds (4 comments) before the spec was approved — two concurrent reviews caused a race condition where one saw the timestamp fix and one didn't

### Token efficiency
- Highest-token actions: Spec review response cycles (3 rounds before approval)
- Avoidable waste: The concurrent spec reviews wasted a round — sequential would've been cleaner
- Suggestions: Self-review subagent caught the dead file issue, proving its value — don't skip it

### Infrastructure gaps
- Repeated workarounds: Settings test fixtures need manual updates in ~9 files when adding a field — a centralized test settings factory would reduce this
- Missing tooling / config: None
- Unresolved debt: GeneralSettings probeFfmpeg untested during form submission (pre-existing, logged to debt.md)

### Wish I'd Known
1. Settings blast radius is real — 9 test files needed updating for one new field. The spec review flagged this but the actual grep/fix took time. A shared test helper for settings forms would help. (see `settings-blast-radius-pattern.md`)
2. Consolidating jobs changes their schedule — blacklist cleanup went from daily to weekly. Always verify the original schedule matters for correctness. (see `blacklist-cleanup-frequency-change.md`)
3. Always `git rm` old files when consolidating, not just removing imports — self-review caught dead code. (see `dead-code-after-consolidation.md`)

## #280 Backup and Restore System — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #330

### Metrics
- Files changed: 18 | Tests added/modified: 6 test files, 40+ tests
- Quality gate runs: 2 (pass on attempt 2 — first had lint fixes for unused imports and return-await)
- Fix iterations: 3 (unused TrashIcon import, max-lines-per-function extraction, return-await in catch blocks)
- Context compactions: 1 (required session continuation)

### Workflow experience
- What went smoothly: Startup swap pattern was well-defined in spec, settings registry auto-derives types cleanly, SettingsSection component made the UI consistent with other settings pages
- Friction / issues encountered: `fetchApi()` forces JSON Content-Type — had to use raw `fetch()` for multipart restore upload. `return-await` eslint rule has nuanced behavior (required in try blocks, forbidden in catch blocks). BackupTable extraction was forced by max-lines-per-function rule mid-implementation. Mock typing in tests required `as unknown as Type` double-cast pattern.

### Token efficiency
- Highest-token actions: Coverage review subagent + self-review subagent consumed significant context. Test implementation across 6 files was the bulk of implementation work.
- Avoidable waste: The coverage review flagged some items that were already tested but not recognized. Could have run verify earlier to catch lint issues before the full review cycle.
- Suggestions: Run `pnpm lint` after each major code batch to catch return-await and max-lines early, rather than discovering them at verify time.

### Infrastructure gaps
- Repeated workarounds: `as unknown as Type` double-cast for mocking services in tests — no shared mock factory
- Missing tooling / config: No helper for multipart uploads in the API client layer
- Unresolved debt: system.ts route file growing, no backup encryption, in-memory pending restore state — logged in debt.md

### Wish I'd Known
1. `fetchApi()` auto-sets `Content-Type: application/json` — multipart uploads MUST bypass it and use raw `fetch()` with FormData (see `multipart-upload-skip-fetchapi.md`)
2. SQLite DB replacement while libSQL holds a connection is unsafe — the startup swap pattern (stage file, exit, swap on boot before DB open) is the only safe approach (see `startup-swap-restore-pattern.md`)
3. The `return-await` eslint rule has three contexts: required inside try blocks, forbidden in catch blocks, forbidden at function end — getting this wrong causes lint failures that aren't obvious from the error message

## #282 UI Enhancements — Table View, Filters, Bulk Actions, Pending Review UX — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #328

### Metrics
- Files changed: 28 | Tests added/modified: 95+
- Quality gate runs: 4 (pass on attempt 1, then test stub implementations needed 2 more lint fixes)
- Fix iterations: 3 (eslint complexity in helpers.ts, max-lines in books.ts and LibraryPage.tsx)
- Context compactions: 1 (required session continuation)

### Workflow experience
- What went smoothly: Component extraction pattern (ViewToggle, LibraryModals) cleanly resolved lint limits. The fieldExtractors lookup map pattern elegantly solved complexity lint rule.
- Friction / issues encountered: ESLint complexity rule counts switch cases individually, so a sort-field switch with 8 cases hit 18 vs max 15. Required converting to a Record lookup map. Also, moving approve/reject buttons behind an expand toggle broke 8 tests across 2 files that expected those buttons to be immediately visible.

### Token efficiency
- Highest-token actions: Test stub implementation (7 test files, 95+ tests) consumed significant context across multiple parallel agents
- Avoidable waste: The coverage review agent flagged 14 "untested" items, most of which were either pre-existing or already tested by earlier agents. Could skip re-scanning test files that agents just wrote.
- Suggestions: When agents implement test stubs, skip the exhaustive coverage review — the stubs themselves define the coverage contract

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No auto-detection of pre-existing vs new behaviors in coverage review
- Unresolved debt: `matchesStatusFilter()` doesn't handle 'failed' status — logged in debt.md

### Wish I'd Known
1. ESLint complexity counts each switch case — use lookup maps for field dispatch (see `eslint-complexity-lookup-map.md`)
2. Moving UI elements behind expand/collapse breaks ALL upstream tests that interact with those elements — run full test suite early after such refactors (see `pending-review-expand-test-pattern.md`)
3. Route files are already at max-lines — always extract new route handlers into standalone functions (see `max-lines-route-extraction.md`)

## #283 Real-Time Updates via SSE — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #327

### Metrics
- Files changed: 16 | Tests added/modified: 4 files (44 new tests)
- Quality gate runs: 3 (pass on attempt 3 — lint, type, and import path fixes needed)
- Fix iterations: 2 (import path typo, Drizzle type incompatibility with Zod enum)
- Context compactions: 1 (session continued from prior context)

### Workflow experience
- What went smoothly: The data-driven architecture (CACHE_INVALIDATION_MATRIX, TOAST_EVENT_CONFIG) paid off — no switch statements, clean extension point. Fire-and-forget pattern with `broadcaster?.emit()` kept existing tests working without changes.
- Friction / issues encountered: (1) EventSource API doesn't support cookies — needed SSEProvider to fetch API key. (2) Drizzle's `$inferSelect` type for enum columns isn't assignable to Zod `z.enum()` — had to widen to `z.string()`. (3) Fastify inject() hangs on SSE endpoints — had to test route handler directly.

### Token efficiency
- Highest-token actions: Reading all mutation sites across 4 services + monitor.ts (each 300-500 lines), coverage review subagent (returned false positives)
- Avoidable waste: Coverage review subagent reported 32 "untested behaviors" but most were false positives — it didn't read the actual test files
- Suggestions: For future coverage reviews, explicitly list test file paths for the subagent to read

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No `@/` alias for `src/shared/` — client code must use relative paths to import shared schemas
- Unresolved debt: QualityGateService needs max-lines eslint override (535 lines with SSE emissions)

### Wish I'd Known
1. EventSource API doesn't support `credentials: 'include'` — the `?apikey=` query param fallback was already in the auth plugin but not obvious until implementation (see `eventsource-auth-cookies.md`)
2. Drizzle inferred types and Zod enums don't mix — use `z.string()` for informational fields to avoid type gymnastics (see `drizzle-inferred-types-sse.md`)
3. Fastify inject() blocks forever on hijacked responses — test SSE handlers directly, not through inject (see `fastify-sse-hijack-testing.md`)

## #292 linuxserver.io Compatibility — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #326

### Metrics
- Files changed: 10 (3 new, 2 deleted, 5 modified) | Tests added/modified: 2 files (17 new tests + 1 updated)
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean infrastructure-only change. No app code modifications needed. s6-overlay integration was straightforward — create service files, swap base image, remove custom entrypoint.
- Friction / issues encountered: Spec review took 2 rounds to get right — LSIO's abc user remap model and PUID=0 behavior needed correction. The elaborate/review-spec cycle caught real factual errors about how LSIO init works.

### Token efficiency
- Highest-token actions: Spec review response rounds (reading full comments, updating issue body, writing learnings)
- Avoidable waste: The elaborate phase explored extensively despite this being a well-defined infrastructure task
- Suggestions: For infrastructure-only issues (Dockerfile, CI), the explore phase could be shorter since there's less code interaction to analyze

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No Docker build/run in CI to actually validate the LSIO image builds and starts correctly
- Unresolved debt: Multi-arch Docker CI still missing (from #284)

### Wish I'd Known
1. LSIO base images use `s6-setuidgid abc` in service run scripts — the abc user is pre-created and remapped, not created at runtime like the old entrypoint approach
2. LSIO base doesn't include Node.js — must install via apk (not obvious from the spec alone)
3. No ENTRYPOINT should be set — LSIO s6-overlay IS the entrypoint and handles all init/supervision

## #284 Deployment Enhancements — ARM64, PUID/PGID, URL Base — 2026-03-09
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #325

### Metrics
- Files changed: ~25 | Tests added/modified: 4 test files (21 new tests)
- Quality gate runs: 4 (pass on attempt 4 — lint complexity, test failures, coverage gate, coverage gate again)
- Fix iterations: 4 (complexity extraction, test registration timing, server-utils extraction, entry point exclusion)
- Context compactions: 1 (session resumed from compacted context)

### Workflow experience
- What went smoothly: Config parsing, auth plugin URL_BASE integration, frontend injection pattern, cover URL utility, Dockerfile/entrypoint
- Friction / issues encountered: Coverage gate was the main pain point — V8 coverage includes all loaded files regardless of vitest exclude config, so entry points with side effects (index.ts, main.tsx) showed 0% even when excluded. Required extracting helpers to separate module AND adding entry point exclusion to verify.ts.

### Token efficiency
- Highest-token actions: Coverage review subagent (overly broad — reviewed ALL behaviors in changed files, not just new ones; many false positives). Self-review subagent was more focused.
- Avoidable waste: Could have anticipated the complexity/coverage issues earlier by checking lint and coverage before committing all changes.
- Suggestions: Run `pnpm lint` after each significant code change to catch complexity violations early. Check coverage implications before modifying entry point files.

### Infrastructure gaps
- Repeated workarounds: V8 coverage JSON includes excluded files — had to add entry point exclusion to both vitest.config.ts AND verify.ts
- Missing tooling / config: No CI/CD pipeline for multi-arch Docker builds (docker buildx)
- Unresolved debt: CSP unsafe-inline for config script injection, registerStaticAndSpa untested, multi-arch CI pipeline needed

### Wish I'd Known
1. V8 coverage provider ignores vitest exclude for JSON output — if your verify script reads coverage-summary.json directly, you need a separate exclusion mechanism (see `v8-coverage-includes-all-loaded.md`)
2. Fastify `fp()` plugins propagate to parent scope while scoped routes don't — auth plugin sees full URL including prefix, route handlers see URL without prefix (see `fastify-scoped-prefix-auth-interaction.md`)
3. Routes registered after `app.ready()` don't wire hooks properly — test helpers must accept routes callback before ready (see `fastify-routes-after-ready.md`)

## #271 Blacklist Improvements — Reason Codes and TTL — 2026-03-09
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #321

### Metrics
- Files changed: ~25 | Tests added/modified: ~50+
- Quality gate runs: 3 (pass on attempt 1 after each round of fixes)
- Fix iterations: 3 (settings fixture deep-merge, migration breakpoints, monitor test assertion updates)
- Context compactions: 1 (caused need to re-read files but no rework)

### Workflow experience
- What went smoothly: Schema extension, service layer, route layer, and cleanup job all went cleanly. Test stubs from /plan provided good scaffolding.
- Friction / issues encountered: Wide fixture blast radius — adding `blacklistTtlDays` to search settings broke 12+ test files that partially override settings. Fixed by converting factory to DeepPartial with deep-merge. Also `pnpm db:generate` is broken on Windows (CJS/ESM issue with drizzle-kit), so migration SQL had to be written manually.

### Token efficiency
- Highest-token actions: Wide fixture migration across 12+ test files, monitor.test.ts modifications (large file)
- Avoidable waste: Could have predicted the settings fixture breakage and fixed the factory FIRST before adding the new field
- Suggestions: When adding fields to nested settings schemas, always update the factory's merge strategy first

### Infrastructure gaps
- Repeated workarounds: Manual migration SQL writing due to broken db:generate
- Missing tooling / config: drizzle-kit CJS/ESM fix for Windows
- Unresolved debt: monitor.ts overlapping try/catch patterns

### Wish I'd Known
1. Adding a field to a nested settings category causes a wide blast radius in test fixtures — fix the factory's merge strategy first
2. SQLite ALTER TABLE statements need `--> statement-breakpoint` markers in Drizzle migrations — they can't be combined
3. Optimistic updates for type toggles need careful handling of derived nullable fields (expiresAt) that the server computes

# Workflow Log

## #355 Add Pagination Infrastructure to Unbounded Queries — 2026-03-13
**Skill path:** /elaborate → /respond-to-spec-review (x4) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #373

### Metrics
- Files changed: ~35 | Tests added/modified: ~30
- Quality gate runs: 2 (pass on attempt 2 — lint fix in blacklist route)
- Fix iterations: 1 (blacklist.ts lint: `import type` + `return await`)
- Context compactions: 0

### Workflow experience
- What went smoothly: Service pattern was consistent across all four — once one was done, the rest were mechanical. TanStack Query's `select()` perfectly isolated the envelope unwrapping from component code.
- Friction / issues encountered: 4 rounds of spec review before approval — the core tension (can't enforce limits without pagination UI) took 3 rounds to resolve by rescoping as Phase 1/2. Stale merge conflicts in unrelated test files blocked first commit. mockDbChain missing `offset` method.

### Token efficiency
- Highest-token actions: Spec review rounds (4 rounds), Explore subagent for codebase exploration, batch test mock updates across ~100 sites
- Avoidable waste: The 4-round spec review cycle could have been 1-2 rounds if the original spec had honestly scoped as "infrastructure only" from the start
- Suggestions: When a spec says "add X to Y" but Y's consumers can't handle X without UI changes, scope as infrastructure-only immediately rather than iterating toward that conclusion

### Infrastructure gaps
- Repeated workarounds: Stale merge conflict markers from unrelated stashes blocking commits on every branch
- Missing tooling / config: mockDbChain should auto-generate all Drizzle chainable methods rather than maintaining a manual list
- Unresolved debt: BookService slim select uses explicit column list that must sync with schema

### Wish I'd Known
1. The fundamental tension between "bound queries" and "no pagination UI" would dominate spec review — should have scoped as Phase 1 infrastructure from the start
2. Response shape changes (array → envelope) have ~30-file blast radius — count callers before committing to the approach
3. TanStack Query's `query.state.data` in callbacks is always raw (pre-select), not the transformed value — this distinction matters for refetchInterval logic

## #357 Refactor Search Pipeline — Deduplicate search-and-grab loop, extract from routes — 2026-03-13
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #371

### Metrics
- Files changed: 10 | Tests added/modified: 2 (search-pipeline.test.ts new, search.test.ts updated)
- Quality gate runs: 2 (pass on attempt 2 — lint errors on first run)
- Fix iterations: 1 (lint: `import()` type annotation and unused import)
- Context compactions: 0

### Workflow experience
- What went smoothly: The extraction was clean — functions moved with no signature changes, tests moved with only import path updates. The 5-module plan worked well for a refactoring issue.
- Friction / issues encountered: Pre-existing merge conflicts in `ImportSettingsSection.test.tsx` and `SearchSettingsSection.test.tsx` blocked the first commit. Had to resolve them before any commit could proceed. Also, the `searched++` counter semantics changed subtly when deduplicating — the old code incremented after `searchAll` but before `grab`, so grab failures still counted. After extraction, grab failures throw and the counter doesn't increment. Required a test assertion update.

### Token efficiency
- Highest-token actions: Explore subagent for self-review and coverage review (both thorough)
- Avoidable waste: The spec review went 3 rounds (elaborate → respond → respond) before approval; most findings were from the initial elaboration not reading source carefully enough
- Suggestions: For deduplication issues, the elaboration subagent should independently grep for ALL instances of the pattern, not just validate what the spec names

### Infrastructure gaps
- Repeated workarounds: Pre-existing merge conflicts from stash required manual resolution on every new branch. `claim.ts` should detect and warn about UU files.
- Missing tooling / config: No automated merge conflict detection in `claim.ts`
- Unresolved debt: `runUpgradeSearchJob` still has its own loop (different enough to not fit `searchAndGrabForBook`); `jobs/search.ts` re-exports from `search-pipeline.ts` for backward compat

### Wish I'd Known
1. Pre-existing merge conflicts in settings test files would block ALL commits — should have resolved them immediately after `claim.ts` ran
2. The `searched` counter increment position between search and grab means deduplication changes counter semantics — always check counter placement relative to extracted boundaries
3. `runUpgradeSearchJob` has enough additional logic (quality comparison, double grab-floor check) that it can't simply call `searchAndGrabForBook` — it needed to stay as its own loop with only `buildSearchQuery` deduplication

## #358 API Naming Convention & Collision Guard Completeness — 2026-03-13
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #370

### Metrics
- Files changed: 29 | Tests added/modified: 10
- Quality gate runs: 3 (pass on attempt 3 — coverage gate caught missing useEventHistory.test.ts)
- Fix iterations: 3 (merge conflict resolution, replace_all overshoot on `logout`, coverage gate)
- Context compactions: 0

### Workflow experience
- What went smoothly: TypeScript strict mode made rename verification trivial — `pnpm typecheck` caught every missed caller
- Friction / issues encountered: Pre-existing merge conflicts in SearchSettingsSection.test.tsx and ImportSettingsSection.test.tsx blocked lint/verify. `git checkout --theirs` resolved the import line but left deeper conflicts. Settings test files from the stashed version assumed Save button always visible, but the component conditionally renders it only when `isDirty`. `replace_all` for `logout` was too aggressive — renamed hook's public API method alongside the internal API call.

### Token efficiency
- Highest-token actions: Reading all test files to understand mock patterns, self-review subagent
- Avoidable waste: Could have used targeted grep-based edits for test file renames instead of reading full files
- Suggestions: For mechanical rename refactors, batch the renames by grepping for all call sites first, then edit in parallel

### Infrastructure gaps
- Repeated workarounds: Pre-existing merge conflicts from stale stashes (same issue as #362 debt item)
- Missing tooling: `claim.ts` doesn't check for unmerged files before creating branches (existing debt item)
- Unresolved debt: CredentialsSection lacks dedicated test file (discovered, logged to debt.md)

### Wish I'd Known
1. TanStack Query prefix-matching semantics for `invalidateQueries` — `['eventHistory']` is broader than `['eventHistory', undefined]`. This was caught in spec review but would have been nice to know before writing the spec. (→ `tanstack-query-prefix-key-invalidation.md`)
2. `replace_all` is dangerous for method names shared between API modules and hook return values — `logout` exists on both `api` and `result.current`. (→ `replace-all-overshoot-hook-api.md`)
3. Settings section tests from pre-#362 branch assume Save button is always visible, but post-per-section-save components conditionally render it only when `isDirty`. (→ `merge-conflict-stash-upstream-save-button.md`)

## #362 Test Pattern Cleanup — Replace brittle selectors and fireEvent usage — 2026-03-13
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #369

### Metrics
- Files changed: 20 | Tests added/modified: 0 new, 20 files cleaned up (31 insertions, 38 deletions)
- Quality gate runs: 1 (pass on attempt 1)
- Fix iterations: 2 (number input isDirty constraint discovery, pre-existing merge conflict markers from stale stash)
- Context compactions: 1 (caused continuation session)

### Workflow experience
- What went smoothly: Mechanical replacements were straightforward — `container.innerHTML === ''` → `toBeEmptyDOMElement()`, `.animate-spin` → `getByTestId('loading-spinner')`, CSS class selectors → `getByTestId('modal-backdrop')`, `.previousElementSibling` → `getByRole('checkbox', { name })`. All 20 files passed on first verify run.
- Friction / issues encountered: (1) Pre-existing merge conflict markers from a stale `git stash pop` on main blocked ALL commits on every branch — took investigation to diagnose. (2) Attempted to convert `fireEvent.submit` to `userEvent` interactions on BackupScheduleForm but discovered RHF `valueAsNumber` + jsdom is fundamentally incompatible with making forms dirty through any event mechanism. (3) Context compaction mid-handoff required continuation session.

### Token efficiency
- Highest-token actions: Self-review and coverage review subagents (~60-80K each), M-32 number input exploration (4 failed approaches before confirming constraint)
- Avoidable waste: The M-32 exploration through `user.clear()`, `user.tripleClick()`, `fireEvent.change`, `fireEvent.input` could have been skipped — the learning from #339 already documented this constraint
- Suggestions: Check `.claude/cl/learnings/` for relevant constraints BEFORE attempting workarounds on known-problematic patterns

### Infrastructure gaps
- Repeated workarounds: `fireEvent.submit` for RHF number-input forms (BackupScheduleForm, NetworkSettingsSection) — same workaround documented twice now
- Missing tooling / config: claim.ts doesn't check for unmerged files from stale stashes before creating branches
- Unresolved debt: claim.ts unmerged file check (logged in debt.md)

### Wish I'd Known
1. Pre-existing merge conflict markers from `git stash pop` block ALL commits on every branch — always check `git status` for UU files before starting work (see `stash-conflict-markers-block-commit.md`)
2. The number input + RHF `valueAsNumber` + jsdom constraint was already documented in `number-input-rhf-isdirty-jsdom.md` from #339 — reading learnings upfront would have saved 4 failed approach attempts (see `number-input-rhf-isdirty-jsdom.md`)
3. For mechanical bulk-edit chore issues, the elaborate/spec-review cycle adds more overhead than value — the spec needed 2 review rounds to narrow scope that was obvious from reading the code directly

## #198 Custom post-processing script support — 2026-03-12
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #348

### Metrics
- Files changed: 7 | Tests added/modified: 24 (15 unit, 4 integration, 5 UI)
- Quality gate runs: 3 (pass on attempt 3 — first had lint errors, second had typecheck from unfixed fixtures)
- Fix iterations: 2 (lint: `as Function` → `as (...args: unknown[]) => void` + complexity extraction; typecheck: hardcoded processing fixtures missing new fields)
- Context compactions: 1 (caused need to re-read files but no rework)

### Workflow experience
- What went smoothly: Schema + utility module TDD was clean. Import service integration followed existing tag-embedding pattern perfectly.
- Friction / issues encountered: Settings fixture blast radius was the biggest time sink — 10+ hardcoded processing objects across test files needed updating. The `enabled: true` variants could be batch-replaced but `enabled: false` needed individual handling. Also hit merge conflicts with #341 branch on settings test files (Import/Library/Search sections).

### Token efficiency
- Highest-token actions: Coverage review subagent (92k tokens), self-review subagent (67k tokens)
- Avoidable waste: Could have planned the fixture blast radius as a distinct module upfront instead of discovering it during verify
- Suggestions: For settings schema changes, always grep for hardcoded fixtures before starting implementation to know the blast radius early

### Infrastructure gaps
- Repeated workarounds: Full processing object overrides in tests (10+ places) — should use partial overrides with createMockSettings()
- Missing tooling / config: No automated detection of hardcoded settings fixtures that will break on schema changes
- Unresolved debt: Hardcoded processing fixtures (logged in debt.md)

### Wish I'd Known
1. Adding fields to processing schema breaks 10+ hardcoded fixtures across BookDetails.test.tsx and ProcessingSettingsSection.test.tsx — plan this as a distinct module in TDD
2. `minFreeSpaceGB: 0` is the pattern for skipping disk space checks in import service tests — without it, you need to mock statfs
3. `as Function` callback casts fail the `no-unsafe-function-type` lint rule — use `as (...args: unknown[]) => void` from the start

## #341 Per-Section Save for General Settings — 2026-03-12
**Skill path:** /implement → /claim (manual) → /plan (skipped - prior work) → /handoff
**Outcome:** success — PR #347

### Metrics
- Files changed: 16 | Tests added/modified: 11
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (Import/Search tests still had old props-based pattern; also conditional save button tests needed updating)
- Context compactions: 0

### Workflow experience
- What went smoothly: The prior implementation was mostly complete — 6 commits already on branch. Just needed to fix 2 test files and add design polish (conditional save button rendering).
- Friction / issues encountered: claim.ts failed because branch already existed from prior attempt — had to manually checkout. Self-review and coverage review subagents ran against wrong branch (#285) after an accidental branch switch mid-conversation, wasting tokens.

### Token efficiency
- Highest-token actions: Self-review and coverage review subagents (ran against wrong branch, results were mostly irrelevant)
- Avoidable waste: Branch context switch happened silently — the system-reminders showed file diffs from the #285 branch. Could have caught this earlier by checking `git branch --show-current` before launching subagents.
- Suggestions: Always verify branch before launching expensive subagents. The claim.ts failure left us on the wrong branch.

### Infrastructure gaps
- Repeated workarounds: Manual branch checkout when claim.ts can't handle existing branches
- Missing tooling / config: claim.ts --resume flag for picking up where a prior attempt left off
- Unresolved debt: claim.ts doesn't handle existing branches gracefully

### Wish I'd Known
1. The branch already existed with 6 implementation commits — checking `git log` first would have saved the claim attempt and revealed the scope of remaining work immediately
2. DEFAULT_SETTINGS.search.enabled defaults to `true`, not `false` — this caused subtle test timing issues where assertions hit default values before the useEffect reset
3. Conditional save button rendering (`{isDirty && ...}`) breaks all tests that used `fireEvent.submit(button.closest('form'))` to bypass isDirty — they need to make forms dirty first

## #285 Import Lists — Audiobookshelf, NYT Bestsellers, Hardcover — 2026-03-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #346

### Metrics
- Files changed: ~30 | Tests added/modified: ~50 tests across 8 test files
- Quality gate runs: 2 (pass on attempt 2 — first failed on lint complexity + stale test counts)
- Fix iterations: 3 (lint complexity extraction, job/app test count updates, preview schema bug)
- Context compactions: 1 (caused continuation session, lost some file-read context)

### Workflow experience
- What went smoothly: Module-by-module TDD worked well for this scope. Committing per-module gave clear git history and recovery points. MSW mocking for HTTP providers was clean.
- Friction / issues encountered: Context compaction mid-implementation (8 modules is a lot for one session). The continuation summary needed manual assembly. ConfirmModal props mismatch was caught by self-review but could have been caught earlier by reading the component before using it. Form labels without htmlFor broke getByLabelText tests.

### Token efficiency
- Highest-token actions: Self-review and coverage review subagents (~70K tokens each), frontend test debugging (multiple read/run cycles)
- Avoidable waste: Could have read ConfirmModal.tsx props before writing the delete modal JSX. Could have checked existing job/app test counts before committing.
- Suggestions: For large features, read all interface/type files upfront before writing implementations to avoid prop mismatches.

### Infrastructure gaps
- Repeated workarounds: drizzle-kit broken on Windows (manual migration SQL again)
- Missing tooling / config: No automated check for stale test counts when adding new jobs/routes
- Unresolved debt: Form labels lack htmlFor (accessibility), preview schema was reusing create schema

### Wish I'd Known
1. ConfirmModal requires `isOpen` prop — conditional render wrapping doesn't work because the component returns null when isOpen is falsy. Read component interfaces before using them.
2. Preview/test-config endpoints need their own schema, not the create schema. Route tests that send the full payload mask the bug — test with minimal payloads.
3. Adding a new cron job requires updating test count assertions in `jobs/index.test.ts` AND adding the mock export to the `App.test.tsx` settings mock.

## #339 Harden Flaky Frontend Tests — waitFor and Number Input Patterns — 2026-03-11
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #345

### Metrics
- Files changed: 17 | Tests added/modified: 0 new, ~40+ assertions wrapped in waitFor
- Quality gate runs: 2 (pass on attempt 2 — first failed on unused `user` variables)
- Fix iterations: 1 (lint fix for unused variables left by agents after fireEvent.change conversion)
- Context compactions: 3 (caused full restart of implementation twice)

### Workflow experience
- What went smoothly: Parallelizing agent work across 3 batches was effective — 9 files fixed simultaneously
- Friction / issues encountered: Context compactions across 3 sessions caused full rework twice. Agent work was lost between sessions (clean git status on re-entry). Linter auto-fix hook modified LibraryPage.test.tsx after checkout, requiring an extra commit.

### Token efficiency
- Highest-token actions: Reading all 17 test files to identify Pattern A violations; re-reading files after context compaction
- Avoidable waste: Two full restarts due to context compaction losing uncommitted agent work. Should commit agent results immediately rather than batching.
- Suggestions: For mechanical bulk-edit issues, commit each agent batch immediately instead of accumulating uncommitted changes across the session.

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No mechanism to persist agent edits across context compactions — agents write to working tree but nothing survives session loss
- Unresolved debt: None introduced

### Wish I'd Known
1. **Commit agent work immediately.** Background agents write to the working tree, and context compactions lose track of uncommitted changes. Commit each agent batch as soon as it completes.
2. **Agents leave unused variables.** When converting `userEvent.clear+type` to `fireEvent.change`, agents consistently leave behind `const user = userEvent.setup()`. Include explicit cleanup instructions in the agent prompt.
3. **Not all spec-listed files have violations.** AuthorPage and BackupScheduleForm were listed in scope but had zero Pattern A/B violations. Always verify assertion types against the actual spec criteria before editing.

## #342 Add dropdown clipped by adjacent search result card — 2026-03-11
**Skill path:** /elaborate → /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #344

### Metrics
- Files changed: 2 | Tests added/modified: 9 new, 11 unchanged
- Quality gate runs: 2 (pass on attempt 2 — first blocked by pre-existing metrics.ts lint errors)
- Fix iterations: 1 (test selector fix — `/add/i` matched both trigger and portal button)
- Context compactions: 0

### Workflow experience
- What went smoothly: Single-file bug fix with clear root cause. Portal pattern was straightforward. All 50 caller regression tests passed without modification.
- Friction / issues encountered: Started implementation on wrong branch (#341 instead of #342) — had to stash and switch. Pre-existing lint errors in `scripts/metrics.ts` blocked verify — had to fix those too (main got the fix separately, causing a rebase conflict resolved with `--skip`). Gitea CLI env vars (`GITEA_URL`, `GITEA_OWNER`, `GITEA_REPO`) weren't in `.env` file, requiring manual export.

### Token efficiency
- Highest-token actions: Explore subagents for elaboration and self-review (each ~50-60k tokens)
- Avoidable waste: Elaborate + respond-to-spec-review happened in same conversation as implement, consuming context that could have been separate
- Suggestions: For simple bugs with clear root cause, skip elaborate and go straight to /implement

### Infrastructure gaps
- Repeated workarounds: GITEA env vars missing from .env — had to export manually each time
- Missing tooling / config: verify.ts doesn't distinguish pre-existing lint errors from new ones — a file-scoped lint check would prevent false blocks
- Unresolved debt: None introduced

### Wish I'd Known
1. `backdrop-blur-xl` creates stacking contexts — this is the root cause, not overflow:hidden (see `backdrop-blur-stacking-context.md`)
2. Portal breaks `ref.contains()` for outside-click — need dual refs (see `portal-dual-ref-click-handling.md`)
3. Test selectors with `/add/i` match both "Add" trigger and "Add to Library" portal button — use `/^add$/i` for exact match

## #315 Encrypt secrets at rest (API keys, proxy auth, client passwords) — 2026-03-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #343

### Metrics
- Files changed: 20 | Tests added/modified: 12
- Quality gate runs: 3 (pass on attempt 3)
- Fix iterations: 4 (key init in tests, adapter decryption, SettingsCategory type mismatch, accidental file commit)
- Context compactions: 2 (caused branch switch — had to re-checkout correct branch)

### Workflow experience
- What went smoothly: Secret codec module and migration were clean TDD. Service integration followed a clear pattern across all 5 services.
- Friction / issues encountered: Cross-cutting encryption required updating every service test file (key init). The `getAdapter()` decryption bug was subtle — encrypted API keys were sent in HTTP requests. SettingsCategory type mismatch (`prowlarr`/`auth` aren't SettingsCategory values) required understanding the split between SettingsService and dedicated services. Context compaction switched branches silently.

### Token efficiency
- Highest-token actions: Coverage review subagent (131K tokens), self-review subagent (37K tokens)
- Avoidable waste: Self-review subagent ran on wrong branch after compaction — wasted a full agent run. Coverage review agent missed existing test files (secret-codec.test.ts, secret-migration.test.ts) and reported false negatives.
- Suggestions: Verify branch before launching subagents. Consider lighter-weight self-review for encryption-focused changes.

### Infrastructure gaps
- Repeated workarounds: scripts/metrics.ts has pre-existing unused imports requiring suppression on every branch that touches it
- Missing tooling / config: No test helper to auto-init encryption key — every test file must manually call initializeKey/resetKey
- Unresolved debt: Key rotation CLI deferred, scripts/metrics.ts unused imports

### Wish I'd Known
1. `SettingsCategory` and `SecretEntity` are different type domains — prowlarr/auth are entities but not settings categories. Would have avoided the typecheck failure. (see `settings-category-vs-entity-types.md`)
2. `getAdapter()` is the critical choke point for decryption — every search/poll/test path flows through it. Should have been the first thing to audit. (see `adapter-decryption-trap.md`)
3. Adding a module-level singleton (`initializeKey`) creates a blast radius across ALL test files, not just the ones you modify. Budget 30% of test time for this. (see `encryption-key-init-test-blast-radius.md`)

## #329 Upgrade to Latest Package Versions — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #340

### Metrics
- Files changed: 18 | Tests added/modified: 12 (type fixes only, no new tests)
- Quality gate runs: 1 (pass on attempt 1)
- Fix iterations: 3 (Vitest 4 type errors across 7 files, constructor mock syntax, environmentMatchGlobs removal)
- Context compactions: 1 (caused continuation from summary — no rework needed)

### Workflow experience
- What went smoothly: Phased upgrade approach isolated breakage perfectly — each major version bump was a clean commit. Drizzle, node-cron, Fastify plugins, and Tailwind all upgraded cleanly.
- Friction / issues encountered: Vitest 4 had the most widespread breakage — Mock type changes, vi.spyOn cast changes, constructor mock syntax, and environmentMatchGlobs removal. Each required discovering the fix through trial and error since Vitest 4 migration docs don't cover all edge cases. Context compaction mid-Vitest-fix phase required reading summary to continue.

### Token efficiency
- Highest-token actions: Vitest 4 type fixes — iterative typecheck → fix → typecheck cycles across 7+ test files
- Avoidable waste: Could have searched for all `vi.spyOn(x as never` and `mockImplementation(() =>` patterns upfront instead of fixing file by file
- Suggestions: For major version upgrades, grep for all known breaking patterns before starting fixes

### Infrastructure gaps
- Repeated workarounds: `as any` with eslint-disable for vi.spyOn on private methods — no clean Vitest 4 alternative exists
- Missing tooling / config: No automated migration tooling for Vitest environmentMatchGlobs → projects
- Unresolved debt: tailwind-merge unused in codebase, eslint-plugin-react-hooks blocks ESLint 10

### Wish I'd Known
1. Vitest 4's `environmentMatchGlobs` removal causes ALL client tests to silently fail with "document is not defined" — the environment shows `0ms` instead of an error. Check environment timing in test output.
2. Arrow function constructor mocks (`mockImplementation(() => obj)`) can't be used with `new` in Vitest 4 — must use `function()` syntax. The error message ("not a constructor") doesn't mention Vitest at all.
3. Import `Mock` type from `vitest` not `@vitest/spy` — the internal package isn't directly importable even though TypeScript infers types from it.

## #175 Dockerfile and Docker image build pipeline — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #338

### Metrics
- Files changed: 5 | Tests added/modified: 15 new tests in docker/docker-workflow.test.ts
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (self-review caught weak smoke test assertions + unused env var)
- Context compactions: 0

### Workflow experience
- What went smoothly: Pure infra issue with no app code changes — straightforward workflow YAML + config file updates. Existing Docker test patterns (healthcheck.test.ts, s6-service.test.ts) provided clear precedent for structural file assertions.
- Friction / issues encountered: The elaborate/spec-review cycle was heavy for what ended up being a single YAML file + 3 config updates. Two rounds of spec review before the spec was ready.

### Token efficiency
- Highest-token actions: Explore subagent for elaboration (read many files to discover most of the work was already done from #284/#292)
- Avoidable waste: The elaborate step could have been shorter if it had quickly checked for existing Docker files first before doing full codebase analysis
- Suggestions: For infra issues, check for existing artifacts early to scope down fast

### Infrastructure gaps
- Repeated workarounds: none
- Missing tooling / config: No js-yaml dependency, so YAML tests use string matching (acceptable for now)
- Unresolved debt: Quality-gates job duplicated between ci.yaml and docker.yaml (Gitea doesn't support reusable workflows)

### Wish I'd Known
1. Most of this issue was already shipped — Dockerfile, compose, s6, health checks all existed from #284/#292. The spec title was misleading; it was really "add CI publish pipeline."
2. Gitea Actions doesn't support reusable workflows, so the quality-gates job had to be fully duplicated in docker.yaml.
3. No js-yaml in the project — YAML structure tests need string matching, which is fine for workflow files but would be fragile for deeply nested configs.

## #331 Recycling Bin — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #337

### Metrics
- Files changed: 18 | Tests added/modified: 54
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 3 (queue-based mock ordering, metadata-only restore bug from self-review, missing coverage for partial failure + purge error toasts)
- Context compactions: 1 (required session continuation)

### Workflow experience
- What went smoothly: TDD cycle worked well — service tests caught real bugs early. Self-review caught metadata-only restore path bug before it reached review.
- Friction / issues encountered: Context ran out during handoff phase, requiring a continuation session. Queue-based Drizzle mock pattern was tricky for multi-step operations — had to refactor from beforeEach to per-test helpers. Coverage review caught 2 genuinely missing tests.

### Token efficiency
- Highest-token actions: Service test file with 26 tests consumed significant context with queue mock setup. Coverage review subagent ran twice (once per handoff attempt).
- Avoidable waste: Could have written the partial failure and purge error tests during initial UI test implementation instead of needing a coverage review to catch them.
- Suggestions: When writing mutation tests, always test success + error + edge case (partial failure) in the first pass.

### Infrastructure gaps
- Repeated workarounds: ConfirmModal button selection in tests still relies on DOM index rather than accessible names
- Missing tooling / config: No test helper for ConfirmModal interaction (click confirm/cancel)
- Unresolved debt: Concurrent restore race condition noted in debt.md

### Wish I'd Known
1. Queue-based Drizzle mocks need per-test setup, not beforeEach — multi-step flows consume queue entries in unpredictable order when setup is shared
2. Always check "what happens when string fields are empty vs null" during self-review — `path: ''` vs `path: null` have very different semantics downstream
3. Coverage review will catch missing error/edge case toast tests — better to write success/error/edge triple upfront for every mutation

## #279 System and Health Dashboard — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #336

### Metrics
- Files changed: 20+ | Tests added/modified: 65+
- Quality gate runs: 3 (pass on attempt 1 each time, but re-ran after bug fixes)
- Fix iterations: 3 (lint max-lines extraction, self-review wiring bugs, progressUpdatedAt conditional update)
- Context compactions: 2 (large issue with 9 modules)

### Workflow experience
- What went smoothly: Red/green TDD per module was efficient — each module was self-contained and tests caught issues early. The existing patterns (mock services proxy, renderWithProviders) made frontend testing fast.
- Friction / issues encountered: Self-review caught 2 critical integration bugs (health job never called, task registry never populated) that unit tests couldn't catch because each module was tested in isolation. The route file hit lint max-lines requiring extraction mid-implementation. Context compactions lost state requiring careful reconstruction.

### Token efficiency
- Highest-token actions: HealthCheckService tests (25+ tests with complex mocking), coverage review subagent (read all files exhaustively)
- Avoidable waste: Could have wired jobs/index.ts immediately when implementing Module 4 (health check job) instead of discovering the gap in self-review
- Suggestions: Wire integration points as you go, not as a separate step. Check "is this new thing actually called?" immediately after creating it.

### Infrastructure gaps
- Repeated workarounds: Drizzle libsql API doesn't expose `.get()` on db object — had to use `db.run()` with positional row access. This pattern will recur for any new pragma/raw SQL queries.
- Missing tooling / config: No integration test that verifies all jobs are registered at startup. A startup smoke test would catch wiring gaps.
- Unresolved debt: TaskRegistry.estimateNextRun() is a rough approximation; version hardcoded in system info route.

### Wish I'd Known
1. `db.run()` returns `ResultSet` with `.rows` as arrays of arrays (not objects) — spent time debugging `.get()` which doesn't exist on the db object
2. Always wire new services into `startJobs()` / bootstrap immediately when creating them, not as a separate step — isolation between modules means unit tests can't catch wiring gaps
3. Boundary tests with `Date.now()` need a time buffer — even 1ms of execution time makes "exactly at threshold" tests flaky

## #333 Update Version Check — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #335

### Metrics
- Files changed: 16 | Tests added/modified: 5 test files (37+ tests)
- Quality gate runs: 4 (pass on attempt 4 — typecheck errors from settings type mismatch and unused param)
- Fix iterations: 3 (unused settingsService param, Partial<Settings> vs UpdateSettingsInput, settings.update vs get+set for single-field update)
- Context compactions: 1 (required session continuation, summary preserved full context)

### Workflow experience
- What went smoothly: Spec was well-defined after 2 review rounds. Version helper extraction from prowlarr-compat was clean. In-memory cache + DB-backed dismiss split made testing straightforward. Frontend design pass integrated naturally.
- Friction / issues encountered: `SettingsService.update()` doesn't deep-merge — it overwrites entire categories. Updating a single field (`dismissedUpdateVersion`) required changing from `update({system: {...}})` to `get('system')` + spread + `set('system', merged)`. This cascaded through 3 verify attempts.

### Token efficiency
- Highest-token actions: Context compaction recovery (re-reading files), self-review and coverage review subagents
- Avoidable waste: Could have checked the `SettingsService.update()` signature before writing the dismiss route — would have avoided 2 verify iterations
- Suggestions: Always read the service method signature before calling it in a new route

### Infrastructure gaps
- Repeated workarounds: Settings single-field update requires manual get+spread+set pattern (no patch method)
- Missing tooling / config: api-collision.test.ts missing backupsApi module
- Unresolved debt: SettingsService needs a `patch(category, partialFields)` method — logged in debt.md

### Wish I'd Known
1. `SettingsService.update()` calls `set()` per category which OVERWRITES the full value — updating one field clobbers others unless you get+spread+set manually (see `settings-update-partial-vs-full.md`)
2. Module-level `let` caches persist across Vitest test cases — always export a `_reset()` for test cleanup (see `module-level-cache-test-pollution.md`)
3. The `UpdateSettingsInput` type exists for body validation but the service doesn't use it — there's a type/behavior mismatch between the schema layer and the service layer

## #332 DB Housekeeping Job — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #334

### Metrics
- Files changed: 17 | Tests added/modified: 28
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (self-review caught dead blacklist-cleanup files not deleted)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean implementation path — spec was well-defined after 3 review rounds, settings blast radius was called out in advance so no surprise test failures
- Friction / issues encountered: Multiple spec review rounds (4 comments) before the spec was approved — two concurrent reviews caused a race condition where one saw the timestamp fix and one didn't

### Token efficiency
- Highest-token actions: Spec review response cycles (3 rounds before approval)
- Avoidable waste: The concurrent spec reviews wasted a round — sequential would've been cleaner
- Suggestions: Self-review subagent caught the dead file issue, proving its value — don't skip it

### Infrastructure gaps
- Repeated workarounds: Settings test fixtures need manual updates in ~9 files when adding a field — a centralized test settings factory would reduce this
- Missing tooling / config: None
- Unresolved debt: GeneralSettings probeFfmpeg untested during form submission (pre-existing, logged to debt.md)

### Wish I'd Known
1. Settings blast radius is real — 9 test files needed updating for one new field. The spec review flagged this but the actual grep/fix took time. A shared test helper for settings forms would help. (see `settings-blast-radius-pattern.md`)
2. Consolidating jobs changes their schedule — blacklist cleanup went from daily to weekly. Always verify the original schedule matters for correctness. (see `blacklist-cleanup-frequency-change.md`)
3. Always `git rm` old files when consolidating, not just removing imports — self-review caught dead code. (see `dead-code-after-consolidation.md`)

## #280 Backup and Restore System — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #330

### Metrics
- Files changed: 18 | Tests added/modified: 6 test files, 40+ tests
- Quality gate runs: 2 (pass on attempt 2 — first had lint fixes for unused imports and return-await)
- Fix iterations: 3 (unused TrashIcon import, max-lines-per-function extraction, return-await in catch blocks)
- Context compactions: 1 (required session continuation)

### Workflow experience
- What went smoothly: Startup swap pattern was well-defined in spec, settings registry auto-derives types cleanly, SettingsSection component made the UI consistent with other settings pages
- Friction / issues encountered: `fetchApi()` forces JSON Content-Type — had to use raw `fetch()` for multipart restore upload. `return-await` eslint rule has nuanced behavior (required in try blocks, forbidden in catch blocks). BackupTable extraction was forced by max-lines-per-function rule mid-implementation. Mock typing in tests required `as unknown as Type` double-cast pattern.

### Token efficiency
- Highest-token actions: Coverage review subagent + self-review subagent consumed significant context. Test implementation across 6 files was the bulk of implementation work.
- Avoidable waste: The coverage review flagged some items that were already tested but not recognized. Could have run verify earlier to catch lint issues before the full review cycle.
- Suggestions: Run `pnpm lint` after each major code batch to catch return-await and max-lines early, rather than discovering them at verify time.

### Infrastructure gaps
- Repeated workarounds: `as unknown as Type` double-cast for mocking services in tests — no shared mock factory
- Missing tooling / config: No helper for multipart uploads in the API client layer
- Unresolved debt: system.ts route file growing, no backup encryption, in-memory pending restore state — logged in debt.md

### Wish I'd Known
1. `fetchApi()` auto-sets `Content-Type: application/json` — multipart uploads MUST bypass it and use raw `fetch()` with FormData (see `multipart-upload-skip-fetchapi.md`)
2. SQLite DB replacement while libSQL holds a connection is unsafe — the startup swap pattern (stage file, exit, swap on boot before DB open) is the only safe approach (see `startup-swap-restore-pattern.md`)
3. The `return-await` eslint rule has three contexts: required inside try blocks, forbidden in catch blocks, forbidden at function end — getting this wrong causes lint failures that aren't obvious from the error message

## #282 UI Enhancements — Table View, Filters, Bulk Actions, Pending Review UX — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #328

### Metrics
- Files changed: 28 | Tests added/modified: 95+
- Quality gate runs: 4 (pass on attempt 1, then test stub implementations needed 2 more lint fixes)
- Fix iterations: 3 (eslint complexity in helpers.ts, max-lines in books.ts and LibraryPage.tsx)
- Context compactions: 1 (required session continuation)

### Workflow experience
- What went smoothly: Component extraction pattern (ViewToggle, LibraryModals) cleanly resolved lint limits. The fieldExtractors lookup map pattern elegantly solved complexity lint rule.
- Friction / issues encountered: ESLint complexity rule counts switch cases individually, so a sort-field switch with 8 cases hit 18 vs max 15. Required converting to a Record lookup map. Also, moving approve/reject buttons behind an expand toggle broke 8 tests across 2 files that expected those buttons to be immediately visible.

### Token efficiency
- Highest-token actions: Test stub implementation (7 test files, 95+ tests) consumed significant context across multiple parallel agents
- Avoidable waste: The coverage review agent flagged 14 "untested" items, most of which were either pre-existing or already tested by earlier agents. Could skip re-scanning test files that agents just wrote.
- Suggestions: When agents implement test stubs, skip the exhaustive coverage review — the stubs themselves define the coverage contract

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No auto-detection of pre-existing vs new behaviors in coverage review
- Unresolved debt: `matchesStatusFilter()` doesn't handle 'failed' status — logged in debt.md

### Wish I'd Known
1. ESLint complexity counts each switch case — use lookup maps for field dispatch (see `eslint-complexity-lookup-map.md`)
2. Moving UI elements behind expand/collapse breaks ALL upstream tests that interact with those elements — run full test suite early after such refactors (see `pending-review-expand-test-pattern.md`)
3. Route files are already at max-lines — always extract new route handlers into standalone functions (see `max-lines-route-extraction.md`)

## #283 Real-Time Updates via SSE — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #327

### Metrics
- Files changed: 16 | Tests added/modified: 4 files (44 new tests)
- Quality gate runs: 3 (pass on attempt 3 — lint, type, and import path fixes needed)
- Fix iterations: 2 (import path typo, Drizzle type incompatibility with Zod enum)
- Context compactions: 1 (session continued from prior context)

### Workflow experience
- What went smoothly: The data-driven architecture (CACHE_INVALIDATION_MATRIX, TOAST_EVENT_CONFIG) paid off — no switch statements, clean extension point. Fire-and-forget pattern with `broadcaster?.emit()` kept existing tests working without changes.
- Friction / issues encountered: (1) EventSource API doesn't support cookies — needed SSEProvider to fetch API key. (2) Drizzle's `$inferSelect` type for enum columns isn't assignable to Zod `z.enum()` — had to widen to `z.string()`. (3) Fastify inject() hangs on SSE endpoints — had to test route handler directly.

### Token efficiency
- Highest-token actions: Reading all mutation sites across 4 services + monitor.ts (each 300-500 lines), coverage review subagent (returned false positives)
- Avoidable waste: Coverage review subagent reported 32 "untested behaviors" but most were false positives — it didn't read the actual test files
- Suggestions: For future coverage reviews, explicitly list test file paths for the subagent to read

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No `@/` alias for `src/shared/` — client code must use relative paths to import shared schemas
- Unresolved debt: QualityGateService needs max-lines eslint override (535 lines with SSE emissions)

### Wish I'd Known
1. EventSource API doesn't support `credentials: 'include'` — the `?apikey=` query param fallback was already in the auth plugin but not obvious until implementation (see `eventsource-auth-cookies.md`)
2. Drizzle inferred types and Zod enums don't mix — use `z.string()` for informational fields to avoid type gymnastics (see `drizzle-inferred-types-sse.md`)
3. Fastify inject() blocks forever on hijacked responses — test SSE handlers directly, not through inject (see `fastify-sse-hijack-testing.md`)

## #292 linuxserver.io Compatibility — 2026-03-10
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #326

### Metrics
- Files changed: 10 (3 new, 2 deleted, 5 modified) | Tests added/modified: 2 files (17 new tests + 1 updated)
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean infrastructure-only change. No app code modifications needed. s6-overlay integration was straightforward — create service files, swap base image, remove custom entrypoint.
- Friction / issues encountered: Spec review took 2 rounds to get right — LSIO's abc user remap model and PUID=0 behavior needed correction. The elaborate/review-spec cycle caught real factual errors about how LSIO init works.

### Token efficiency
- Highest-token actions: Spec review response rounds (reading full comments, updating issue body, writing learnings)
- Avoidable waste: The elaborate phase explored extensively despite this being a well-defined infrastructure task
- Suggestions: For infrastructure-only issues (Dockerfile, CI), the explore phase could be shorter since there's less code interaction to analyze

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No Docker build/run in CI to actually validate the LSIO image builds and starts correctly
- Unresolved debt: Multi-arch Docker CI still missing (from #284)

### Wish I'd Known
1. LSIO base images use `s6-setuidgid abc` in service run scripts — the abc user is pre-created and remapped, not created at runtime like the old entrypoint approach
2. LSIO base doesn't include Node.js — must install via apk (not obvious from the spec alone)
3. No ENTRYPOINT should be set — LSIO s6-overlay IS the entrypoint and handles all init/supervision

## #284 Deployment Enhancements — ARM64, PUID/PGID, URL Base — 2026-03-09
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #325

### Metrics
- Files changed: ~25 | Tests added/modified: 4 test files (21 new tests)
- Quality gate runs: 4 (pass on attempt 4 — lint complexity, test failures, coverage gate, coverage gate again)
- Fix iterations: 4 (complexity extraction, test registration timing, server-utils extraction, entry point exclusion)
- Context compactions: 1 (session resumed from compacted context)

### Workflow experience
- What went smoothly: Config parsing, auth plugin URL_BASE integration, frontend injection pattern, cover URL utility, Dockerfile/entrypoint
- Friction / issues encountered: Coverage gate was the main pain point — V8 coverage includes all loaded files regardless of vitest exclude config, so entry points with side effects (index.ts, main.tsx) showed 0% even when excluded. Required extracting helpers to separate module AND adding entry point exclusion to verify.ts.

### Token efficiency
- Highest-token actions: Coverage review subagent (overly broad — reviewed ALL behaviors in changed files, not just new ones; many false positives). Self-review subagent was more focused.
- Avoidable waste: Could have anticipated the complexity/coverage issues earlier by checking lint and coverage before committing all changes.
- Suggestions: Run `pnpm lint` after each significant code change to catch complexity violations early. Check coverage implications before modifying entry point files.

### Infrastructure gaps
- Repeated workarounds: V8 coverage JSON includes excluded files — had to add entry point exclusion to both vitest.config.ts AND verify.ts
- Missing tooling / config: No CI/CD pipeline for multi-arch Docker builds (docker buildx)
- Unresolved debt: CSP unsafe-inline for config script injection, registerStaticAndSpa untested, multi-arch CI pipeline needed

### Wish I'd Known
1. V8 coverage provider ignores vitest exclude for JSON output — if your verify script reads coverage-summary.json directly, you need a separate exclusion mechanism (see `v8-coverage-includes-all-loaded.md`)
2. Fastify `fp()` plugins propagate to parent scope while scoped routes don't — auth plugin sees full URL including prefix, route handlers see URL without prefix (see `fastify-scoped-prefix-auth-interaction.md`)
3. Routes registered after `app.ready()` don't wire hooks properly — test helpers must accept routes callback before ready (see `fastify-routes-after-ready.md`)

## #271 Blacklist Improvements — Reason Codes and TTL — 2026-03-09
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #321

### Metrics
- Files changed: ~25 | Tests added/modified: ~50+
- Quality gate runs: 3 (pass on attempt 1 after each round of fixes)
- Fix iterations: 3 (settings fixture deep-merge, migration breakpoints, monitor test assertion updates)
- Context compactions: 1 (caused need to re-read files but no rework)

### Workflow experience
- What went smoothly: Schema extension, service layer, route layer, and cleanup job all went cleanly. Test stubs from /plan provided good scaffolding.
- Friction / issues encountered: Wide fixture blast radius — adding `blacklistTtlDays` to search settings broke 12+ test files that partially override settings. Fixed by converting factory to DeepPartial with deep-merge. Also `pnpm db:generate` is broken on Windows (CJS/ESM issue with drizzle-kit), so migration SQL had to be written manually.

### Token efficiency
- Highest-token actions: Wide fixture migration across 12+ test files, monitor.test.ts modifications (large file)
- Avoidable waste: Could have predicted the settings fixture breakage and fixed the factory FIRST before adding the new field
- Suggestions: When adding fields to nested settings schemas, always update the factory's merge strategy first

### Infrastructure gaps
- Repeated workarounds: Manual migration SQL writing due to broken db:generate
- Missing tooling / config: drizzle-kit CJS/ESM fix for Windows
- Unresolved debt: monitor.ts overlapping try/catch patterns

### Wish I'd Known
1. Adding a field to a nested settings category causes a wide blast radius in test fixtures — fix the factory's merge strategy first
2. SQLite ALTER TABLE statements need `--> statement-breakpoint` markers in Drizzle migrations — they can't be combined
3. Optimistic updates for type toggles need careful handling of derived nullable fields (expiresAt) that the server computes
