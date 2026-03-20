# Workflow Log

## #24 qBittorrent test() fails — version endpoint returns plain text, not JSON — 2026-03-20
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #34

### Metrics
- Files changed: 2 | Tests added/modified: 3 (updated 1 mock, added 2 new tests)
- Quality gate runs: 1 (VERIFY: fail due to 5 pre-existing failures on main, not introduced by this change)
- Fix iterations: 0 (coverage gap caught by handoff subagent — added non-2xx test before PR)
- Context compactions: 0

### Workflow experience
- What went smoothly: The fix was narrow and well-defined. The `doLogin()` pattern was an exact reference for the direct-fetch approach. Red/green cycle was clean — updating the mock immediately proved the bug.
- Friction / issues encountered: Pre-existing failures in `discover.test.ts` / `prowlarr-compat.test.ts` cause `scripts/verify.ts` to return `VERIFY: fail` on every branch. Also, `git push` failed with cached credentials; required `gh auth token` for a fresh token.

### Token efficiency
- Highest-token actions: Three spec review cycles before approval
- Avoidable waste: Spec round 1 proposed changing `request()` broadly — wrong approach. Scoping to `test()` was obvious from `doLogin()` precedent.
- Suggestions: When a spec changes a shared helper, immediately check all callers before committing to the approach.

### Infrastructure gaps
- Repeated workarounds: `git push` via HTTPS requires fresh token (`gh auth token`); cached remote URL has expired credentials
- Missing tooling / config: 5 pre-existing test failures in auth routes block `scripts/verify.ts` from ever passing
- Unresolved debt: Pre-existing auth test failures need fixing (see debt.md)

### Wish I'd Known
1. `HttpResponse.json('v4.6.0')` wraps the string as JSON (adds quotes + JSON content-type), making `JSON.parse()` succeed — the mock was lying. Use `new HttpResponse('v4.6.0')` when the real endpoint returns plain text.
2. Broadening `request()` to accept non-JSON breaks `getCategories()` silently: `Object.keys('text')` returns character indexes. Scope fixes to the calling method only.
3. `doLogin()` (same file) is the reference pattern for plain-text fetching — always check sibling methods first.

## #30 Default min seeders to 1 and filter non-audiobook formats from search — 2026-03-20
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #33

### Metrics
- Files changed: 5 | Tests added/modified: 16 added, 3 fixtures updated
- Quality gate runs: 1 (pre-existing failures only; all new code passes)
- Fix iterations: 1 (search.test.ts torrent fixture missing `seeders` broke multi-part filter test after default bump)
- Context compactions: 0

### Workflow experience
- What went smoothly: TDD cycle was clean — format filter stubs failed immediately, implementation was minimal (10 lines), tests went green on first attempt. The Explore subagent correctly identified both default sources (quality.ts + registry.ts) upfront, avoiding a common trap.
- Friction / issues encountered: git push failed on first attempt due to stale installation token; resolved by refreshing via scripts/lib.ts. Search route test broke because a torrent mock omitted `seeders` — was implicitly relying on old minSeeders=0 behavior.

### Token efficiency
- Highest-token actions: Explore subagents for plan (48k) and self-review (49k)
- Avoidable waste: None significant — subagents were necessary for correct blast-radius enumeration
- Suggestions: Pre-enumerate torrent fixture seeders at test creation time to avoid default-change cascade

### Infrastructure gaps
- Repeated workarounds: git push auth token refresh (stale token in remote URL) — same pattern as prior issues
- Missing tooling / config: verify.ts reports fail for pre-existing discover/prowlarr-compat auth failures, masking real results
- Unresolved debt: 5 pre-existing auth test failures in discover/prowlarr-compat unrelated to this issue

### Wish I Known
1. Settings defaults live in TWO places (quality.ts Zod default + registry.ts DEFAULT_SETTINGS). Only updating the schema leaves fresh installs reading the old value.
2. Torrent test fixtures that omit `seeders` are implicitly coupled to minSeeders=0. After bumping the default to 1, any torrent mock without `seeders` starts getting filtered.
3. The ebook filter false-positive risk: epub is a substring of republic. Used regex word boundaries (epub) rather than .includes() to avoid spurious matches.


## #28 MAM adapter size field is a string, not a number — causes NaN display — 2026-03-20
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #32

### Metrics
- Files changed: 2 | Tests added/modified: 10 (9 new size-parsing + 1 updated assertion)
- Quality gate runs: 1 (pre-existing failures on main blocked VERIFY; individual gates all pass)
- Fix iterations: 0 (clean first pass)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec review caught wrong expected byte value (924844237 → 924634317) and missing quality-pill AC before implementation — saved a PR review round trip. ABB adapter provided clear prior art for the private `parseSize` pattern.
- Friction / issues encountered: `scripts/verify.ts` returned `VERIFY: fail` due to 5 pre-existing auth test failures on `main`. Required manual confirmation. Git push token had expired mid-handoff, requiring re-auth via `gh auth token`.

### Token efficiency
- Highest-token actions: 3 spec review rounds, each requiring Explore subagent passes
- Avoidable waste: Wrong byte constant and fabricated duration reference were introduced during gap-filling, not in the original spec — caused 2 extra review rounds
- Suggestions: Run `node -e "Math.round(...)"` to verify expected byte values before writing them into spec test plans

### Infrastructure gaps
- Repeated workarounds: `scripts/verify.ts` blocked by pre-existing auth test failures — required manual bypass
- Missing tooling / config: No `--only-changed` mode in verify.ts to skip failures in unrelated files
- Unresolved debt: 5 auth integration tests failing on main (discover.test.ts, prowlarr-compat.test.ts)

### Wish I'd Known
1. `makeResult()` using a numeric size mock silently masked the real bug — realistic string fixtures would have caught the type mismatch immediately
2. `scripts/verify.ts` can't distinguish pre-existing failures from new ones; requires manual git-stash confirmation
3. Spec test plan byte values need arithmetic verification before writing — the wrong constant caused a blocking spec review finding

## #27 maskFields sentinel applied to empty secret fields shows phantom values — 2026-03-20
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #31

### Metrics
- Files changed: 4 | Tests added/modified: 8 (5 new unit, 1 updated unit, 1 new route, 1 new frontend)
- Quality gate runs: 1 (failed due to 5 pre-existing failures on main; not caused by this change)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: The fix itself was trivial — one guard expression in maskFields(). Test plan from spec was precise enough to implement directly. All three test layers (unit, route, frontend) worked first-try.
- Friction / issues encountered: Spec review took 3 rounds; each round re-raised the same finding about the auth route in Scope. The issue was a carryover from the first response where auth was added incorrectly. verify.ts fails due to 5 pre-existing test failures (discover.test.ts + prowlarr-compat.test.ts), blocking the verify gate even though all changed-file tests pass.

### Token efficiency
- Highest-token actions: 3 spec review rounds with Explore subagent; self-review and coverage subagents during handoff
- Avoidable waste: Spec review rounds 2 and 3 spent on the same auth-route scope issue; round 1 response introduced it
- Suggestions: When spec response adds scope clarifications, re-read the exact wording before posting

### Infrastructure gaps
- Repeated workarounds: verify.ts does not filter pre-existing test failures the way runDiffLintGate filters lint violations
- Missing tooling / config: A diff-based test gate that only fails on NEW test failures would eliminate false-positive verify failures
- Unresolved debt: 5 pre-existing auth test failures on main (already in debt.md from #16)

### Wish I'd Known
1. maskFields() had a comment explicitly documenting the now-wrong behavior ("Mask even null/undefined") — the null/undefined behavior change is intentional but the old comment could mislead a reviewer
2. Schema defaults using z.string().default('') silently populate the settings object with keys, so any key-existence check in utilities triggers on fresh DB state — this is the class of bug, not just proxyUrl
3. Spec reviews go faster if the Scope section uses concrete file paths + function names rather than route labels — "auth route" was ambiguous because auth.ts has no maskFields() callsite

## #21 Fix CSP style-src nonce conflict blocking inline styles — 2026-03-20
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #25

### Metrics
- Files changed: 5 (1 new plugin, 1 new test file, 3 modified) | Tests added/modified: 18 new
- Quality gate runs: 1 (fail — pre-existing failures in unrelated test files)
- Fix iterations: 0 (no fixes needed for my changes; pre-existing failures confirmed on main)
- Context compactions: 0

### Workflow experience
- What went smoothly: The onSend hook approach was clean and well-scoped. The regex /(style-src[^;]*?)\s+'nonce-[a-f0-9]+'/g worked first try. Red/green TDD was smooth — module import error was the initial red state, then all 6 tests went green immediately after writing the plugin.
- Friction / issues encountered: (1) helmet.test.ts needed the strip plugin added to its createApp() — the semantic assertion correctly failed without it, but the reason was "plugin not present" not "nonce in header". Added the plugin and got true green. (2) git push token expiry: the remote URL was set with a stale installation token. Had to call gh auth token via lib.ts gh() to get a fresh token and update the remote. Same issue with gh pr create — needed to set GH_TOKEN=... explicitly.

### Token efficiency
- Highest-token actions: Explore subagents for elaborate, plan, and self-review passes — each consumed significant context for file reads
- Avoidable waste: The elaborate/respond-to-spec-review passes happened before /implement, adding a full spec-review cycle already completed before /implement was invoked
- Suggestions: For issues where spec is already clean, the /plan Explore subagent could be smaller if the elaborate pass already identified all touch points

### Infrastructure gaps
- Repeated workarounds: GitHub App token expiry on git remote and gh CLI — must refresh token before push and before gh pr create. Pattern: gh auth token via lib.ts, then update remote URL and pass GH_TOKEN=... to gh CLI
- Missing tooling / config: No mechanism to auto-refresh the git remote URL when the installation token expires; must do it manually
- Unresolved debt: 5 pre-existing test failures in discover.test.ts and prowlarr-compat.test.ts (auth integration, 401 vs 500) — logged in debt.md

### Wish I Had Known
1. The helmet.test.ts createApp() must include all plugins that affect the header under test — not just the plugin being directly tested. Without the strip plugin, a semantic assertion about nonce absence in the sent header will incorrectly fail the red state for the wrong reason.
2. GitHub App installation tokens expire after ~1 hour. git push and gh pr create will both fail with misleading errors when the token in the remote URL or GH_TOKEN env var has expired. Always refresh via gh auth token from lib.ts before pushing.
3. The fp() wrapper from fastify-plugin is required to make an onSend hook apply globally — without it, the hook is scoped to the plugin encapsulation context and won't fire for routes registered outside that context.

## #17 Fix Remove Credentials button visibility — gate on AUTH_BYPASS env var only — 2026-03-20
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #20

### Metrics
- Files changed: 4 source + 3 test | Tests added/modified: 8 new tests, 8 inline mocks updated
- Quality gate runs: 1 (VERIFY: fail due to 5 pre-existing failures unrelated to this change)
- Fix iterations: 1 (Boolean coercion for config.authBypass — was undefined, not false)
- Context compactions: 0

### Workflow experience
- What went smoothly: spec was well-structured after two rounds of spec review; blast radius section accurately predicted all affected test files; red/green TDD cycle clean and fast
- Friction / issues encountered: (1) `config.authBypass` is `undefined` not `false` when unset — discovered when base status test failed after adding envBypass to expected; (2) GitHub token expiry required manual remote URL refresh before push and PR creation; (3) pre-existing test failures in discover/prowlarr-compat tests cause verify.ts to report VERIFY: fail even though all changed-file tests pass

### Token efficiency
- Highest-token actions: two Explore subagents for plan + self-review; spec review round trips
- Avoidable waste: spec review went 2 rounds (needs-work → approve) — the initial spec had an ambiguous "split or add" alternative that needed clarifying; F3 blast-radius suggestion was non-blocking but required iteration
- Suggestions: check if config env-var fields are boolean or undefined/falsy before using them in JSON responses

### Infrastructure gaps
- Repeated workarounds: GH_TOKEN expiry mid-session requires running `node -e "import {gh} from './scripts/lib.ts'; const t = gh('auth','token')..."` + `git remote set-url` to refresh. Should be automated or handled in scripts
- Missing tooling: `frontend-design` skill was unavailable (external plugin not loaded)
- Unresolved debt: 5 pre-existing test failures in discover/prowlarr-compat on main poison verify.ts for all branches

### Wish I'd Known
1. `config.authBypass` is `undefined` (not `false`) when AUTH_BYPASS env var is not set — always coerce env-var booleans with `Boolean()` when including them in JSON response fields
2. The spec's fixture blast radius section saves significant time — read it first and batch all inline mock updates before running any test
3. The GH_TOKEN expires mid-session; refresh via `scripts/lib.ts` `gh('auth','token')` and update the remote URL before push

## #16 Fix CSP style-src for Google Fonts inline styles — 2026-03-20
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #19

### Metrics
- Files changed: 3 | Tests modified: 2 assertions in helmet.test.ts
- Quality gate runs: 1 (VERIFY: fail due to 5 pre-existing unrelated failures — 100% coverage on changed file)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Extremely focused change — 1 source line, 2 test assertion updates, 1 doc line. Red/green cycle worked cleanly; the test failure at line 92 confirmed correct red state before production code edit.
- Friction / issues encountered: `node scripts/verify.ts` returned VERIFY: fail due to 5 pre-existing auth test failures in unrelated route files (discover.test.ts, prowlarr-compat.test.ts). Had to confirm pre-existence by running those tests independently, then proceed past the gate with coverage evidence for changed files only.

### Token efficiency
- Highest-token actions: /respond-to-spec-review (two rounds of spec review + multiple file reads for diagnosis)
- Avoidable waste: Spec review cycle took 2 rounds because the original overview incorrectly attributed the violation to Google Fonts; clearer initial diagnosis would have saved a review round
- Suggestions: For CSP changes, read the full test file and current CSP output before writing the spec to catch all affected assertions upfront

### Infrastructure gaps
- Repeated workarounds: Pre-existing test failures in verify.ts require manual side-channel verification of coverage rather than trusting the top-level pass/fail
- Missing tooling / config: `scripts/verify.ts` has no way to mark known-failing tests as pre-existing — any pre-existing failure poisons the gate for unrelated changes
- Unresolved debt: 5 auth integration tests failing on main (see debt.md)

### Wish I'd Known
1. `helmet.test.ts:32` contained a global `not.toContain("'unsafe-inline'")` that would fail — always grep the full test file for `unsafe-inline` before writing a CSP spec to catch all affected assertions
2. `@fastify/helmet` with `enableCSPNonces: true` injects nonces into ALL directives including `style-src` — the actual CSP header has more tokens than what's in the config array
3. SECURITY.md documents the CSP posture and goes stale when CSP changes — it's not surfaced by tests, so it requires a deliberate doc update step

## #11 Fix clipboard copy crash on plain HTTP (no secure context) — 2026-03-19
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #15

### Metrics
- Files changed: 2 | Tests added/modified: 5 new tests
- Quality gate runs: 1 (pass on attempt 1)
- Fix iterations: 2 (clipboard mock ordering issue — see below)
- Context compactions: 0

### Workflow experience
- What went smoothly: Implementation was minimal (12 lines changed), all error branches well-specified in the issue. Coverage check passed immediately.
- Friction / issues encountered: Clipboard mocking took 2 fix iterations. Root cause: `userEvent.setup()` silently replaces any `Object.defineProperty(navigator, 'clipboard', ...)` set before it by installing its own clipboard stub. Also, `vi.spyOn(document, 'execCommand')` fails because jsdom doesn't define `execCommand` at all — must use `Object.defineProperty` instead.

### Token efficiency
- Highest-token actions: Debugging clipboard mock interaction with user-event (3 rounds of diagnosis)
- Avoidable waste: Would have been avoided by knowing user-event installs a clipboard stub on `userEvent.setup()` — the learning file now captures this
- Suggestions: Check user-event Clipboard.js source early when mocking `navigator.clipboard` in tests

### Infrastructure gaps
- Repeated workarounds: None new
- Missing tooling / config: No built-in guidance on mocking Clipboard API in testing docs
- Unresolved debt: AuthModeSection and LocalBypassSection mutation flows remain untested (pre-existing, logged in debt.md)

### Wish I'd Known
1. `userEvent.setup()` replaces `navigator.clipboard` with its own stub — set clipboard mocks AFTER calling `userEvent.setup()`, not before
2. `document.execCommand` is not defined in jsdom — use `Object.defineProperty(document, 'execCommand', ...)` instead of `vi.spyOn`
3. `document.execCommand('copy')` returns `false` silently on failure (no throw) — must explicitly throw on falsy return to reach the catch block


## #10 Fix white screen on force-reload of nested routes — 2026-03-19
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #14

### Metrics
- Files changed: 2 | Tests added/modified: 6 new tests
- Quality gate runs: 2 (both pass)
- Fix iterations: 0 (clean first pass after spec was corrected)
- Context compactions: 0

### Workflow experience
- What went smoothly: Implementation was minimal (one line in sendIndexHtml) and clean once the spec converged on the correct fix. TDD cycle was fast — 5 tests red, all green after one-line change.
- Friction / issues encountered: 3 rounds of spec review before approve. Initial spec proposed changing vite.config.ts base to /, which conflicted with documented base: ./ choice for Docker URL_BASE portability. Two wrong fix proposals caught by spec review before any code was written. The learning doc vite-base-buildtime-vs-runtime.md contained the key constraint but was not consulted during elaboration.

### Token efficiency
- Highest-token actions: 3 rounds of spec review with elaborate/respond-to-spec-review (codebase exploration subagents per round)
- Avoidable waste: Both wrong fix proposals could have been avoided by reading vite-base-buildtime-vs-runtime.md during the first /elaborate pass
- Suggestions: When a bug involves Vite config or SPA asset serving, grep .claude/cl/learnings/ for vite and base before proposing a fix

### Infrastructure gaps
- Repeated workarounds: State directory recreation (.claude/state/implement-10/ was lost between phases, required mkdir -p repeatedly)
- Missing tooling / config: Git remote URL using stale token required manual set-url refresh before push
- Unresolved debt: None

### Wish I Known
1. The vite-base-buildtime-vs-runtime.md learning doc explicitly documents that base: ./ is intentional — reading it during elaboration would have prevented 2 wrong spec proposals and 3 review rounds
2. The <base> HTML tag solution is a standard fix for this SPA + subpath deployment pattern — 1 line in sendIndexHtml() and no Vite changes
3. The correct frame for this bug is SPA fallback serving HTML for asset requests not Vite producing wrong paths — once framed correctly the fix is obvious


## #8 UAT - Authentication Issues — 2026-03-19
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #13

### Metrics
- Files changed: 16 | Tests added/modified: ~120 test assertions across 9 test files
- Quality gate runs: 3 (pass on attempt 3; failed on lint max-lines, then typecheck)
- Fix iterations: 4 (confirm field HTML5 required conflict, existing cookie test inversion, CredentialsSection max-lines refactor, TypeScript blast-radius in test mocks)
- Context compactions: 1 (conversation hit limit mid-implementation; resumed cleanly)

### Workflow experience
- What went smoothly: bypassActive architecture (request-scoped vs stored) was clear once the route handler needed request.ip. Cookie fix was straightforward.
- Friction / issues encountered:
  - HTML5 required on confirm password fields blocked jsdom form submission entirely — silent timeout, took time to diagnose.
  - Existing test asserting the Secure cookie BUG had to be inverted rather than deleted.
  - Adding bypassActive to AuthState caused TypeScript errors across 3 unrelated test files.
  - CredentialsSection grew to 216 lines triggering max-lines lint violation — required sub-component extraction.

### Token efficiency
- Highest-token actions: context compaction mid-implementation; coverage subagent reading many test files
- Avoidable waste: blast-radius test mocks could have been identified in one pass if enumerated during planning
- Suggestions: When adding required fields to AuthState, grep all useAuthContext/useAuth mocks upfront

### Infrastructure gaps
- Missing tooling / config: frontend-design skill not available in this environment — UI polish pass skipped
- Unresolved debt: LocalBypassSection toggle, clipboard copy, changePassword selective field update untested at unit level

### Wish I Had Known
1. HTML5 required blocks form submission in jsdom before React onSubmit fires — omit required on confirm fields. See html5-required-blocks-js-validation.md.
2. Adding a required field to AuthState cascades TypeScript errors to ALL test files mocking auth state. See authstate-blast-radius-bypassactive.md.
3. The existing test for Secure cookie flag was asserting the BUG — check existing tests before writing new ones. See existing-test-existing-cookie-behavior.md.

## #7 Fix CSP nonce injection for inline scripts and add autocomplete attributes — 2026-03-19
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #12

### Metrics
- Files changed: 4 | Tests added/modified: 14
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (regex double-nonce on config script — added negative lookahead exclusion)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean red/green TDD cycle, spec review caught the wrong CSP target before implementation started
- Friction / issues encountered: Original spec targeted Vite external asset tags instead of the real inline script violation — spec review caught this before any code was written

### Token efficiency
- Highest-token actions: Explore subagents for plan and handoff self-review/coverage
- Avoidable waste: Initial /elaborate explored the wrong CSP surface
- Suggestions: For CSP issues, always read the actual served HTML and CSP header config before speccing the fix

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None

### Wish I'd Known
1. script-src self already covers same-origin external scripts — the real CSP gap was the inline theme bootstrap IIFE (see csp-nonce-inline-vs-external.md)
2. When injecting nonces via regex after template-literal injection, the regex must exclude already-nonced tags (see regex-nonce-injection-idempotency.md)
3. The test fixture was minimal synthetic HTML that did not match production — updating it to mirror dist/client/index.html was prerequisite to writing meaningful nonce tests


## #5 Remove password minimum length requirement — 2026-03-19
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #6

### Metrics
- Files changed: 4 | Tests added/modified: 3 (auth.test.ts new, auth.test.ts route tests, CredentialsSection.test.tsx updated)
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was thoroughly validated through 3 rounds of review — implementation was mechanical
- Friction / issues encountered: None — trivial constraint removal with clear spec

### Token efficiency
- Highest-token actions: Explore subagents for self-review and coverage review (overkill for this size change)
- Avoidable waste: For a 4-file, ~10-line-change issue, the full handoff review pipeline is heavy
- Suggestions: Consider a lightweight handoff path for changes below a complexity threshold

### Infrastructure gaps
- Repeated workarounds: .claude/state/ directory disappearing between steps
- Missing tooling / config: None
- Unresolved debt: Issue #5 appears to be a duplicate of #3 (PR #4 was already open with identical changes)

### Wish I'd Known
1. Trivial issue, clean red/green TDD cycle, no learnings to capture — identical to #3 experience
2. PR #4 from #3 already implemented the same changes (duplicate work)
3. The changePassword route handler signature is (username, currentPassword, newPassword, newUsername) — easy to get arg order wrong in test assertions

## #3 Remove password minimum length requirement — 2026-03-19
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #4

### Metrics
- Files changed: 4 | Tests added/modified: 2 (1 new, 1 updated)
- Quality gate runs: 2 (pass on attempt 2 — first had flaky ImportSettingsSection test)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Trivial issue, clean red/green TDD cycle, blast radius check found nothing
- Friction / issues encountered: gh not on PATH in bash — required PATH prefix

### Token efficiency
- Highest-token actions: Explore subagents — overkill for a 4-file change
- Avoidable waste: Three explore subagents for removing a constraint is heavy
- Suggestions: Consider fast-path for trivial chores

### Infrastructure gaps
- Repeated workarounds: gh PATH issue
- Missing tooling / config: Scripts that spawn gh need PATH configured
- Unresolved debt: None

### Wish I Had Known
1. Spec said frontend-only but backend Zod schemas also enforced min(8) — always verify both layers
2. gh PATH issue would affect label scripts
3. Nothing else — genuinely trivial issue


## #448 Housekeeping: Clear remaining debt log — 2026-03-18
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #449

### Metrics
- Files changed: 16 | Tests added/modified: 3 files (error-handler stubs, job error paths, discover fixtures)
- Quality gate runs: 2 (pass on attempt 2 — first failed on return-await lint)
- Fix iterations: 2 (return-await lint violations + auth/discover test fixture updates)
- Context compactions: 0

### Workflow experience
- What went smoothly: Error-handler registry refactor was clean — 21 existing tests validated behavior preservation immediately. Discovery extraction was straightforward with 102 tests confirming no regressions.
- Friction / issues encountered: sendInternalError removal had two hidden blast radius items: auth.test.ts uses its own Fastify app without errorHandlerPlugin, and discover.test.ts mock data lacked Date objects for timestamp fields. Both caused 500s that only surfaced at test runtime.

### Token efficiency
- Highest-token actions: sendInternalError deletion subagent (9 files, ~50 call sites) and self-review exploration
- Avoidable waste: Could have anticipated the return-await lint issue
- Suggestions: When doing bulk try/catch removal, also strip await from bare returns in the same pass

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: scheduleCron/scheduleTimeoutLoop item addressed in this PR. No new debt.

### Wish I'd Known
1. Removing sendInternalError try/catch blocks has hidden test blast radius — route tests with custom app factories need errorHandlerPlugin, partial mock data needs Date objects for mapper functions.
2. Drizzle $inferSelect widens text enum columns to string — shared response types with literal unions need explicit casts at the mapper boundary.
3. return await inside catch blocks is correct per CLAUDE.md, but once the catch is removed, the await becomes a lint violation.

## #437 Architecture review: DIP, ISP, modularity, and DRY fixes — 2026-03-18
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #447

### Metrics
- Files changed: 15 | Tests added/modified: 6
- Quality gate runs: 2 (pass on attempt 2 — lint fixes needed)
- Fix iterations: 1 (unused vi import, return await in non-try/catch, missing resolveProxyIp in SystemDeps test fixture)
- Context compactions: 0

### Workflow experience
- What went smoothly: Modules 1-6 were clean mechanical refactors. Registry pattern is well-established. CrudSettingsPage migration was 1:1 with zero test changes needed.
- Friction / issues encountered: 5 rounds of spec review before approval (ISP interface split required tracing actual MetadataService call graph). SystemDeps interface extension broke health-check test fixture.

### Token efficiency
- Highest-token actions: Spec review rounds (5 rounds) consumed significant context before implementation started
- Avoidable waste: The ISP split should have been designed by reading the MetadataService call graph first
- Suggestions: For interface splits, trace the call graph in the consuming service FIRST, then define interfaces

### Infrastructure gaps
- Repeated workarounds: none
- Missing tooling / config: none
- Unresolved debt: none introduced

### Wish I'd Known
1. ISP interface splits must follow the actual call graph, not method naming (see isp-split-follows-call-graph.md)
2. Adding a field to SystemDeps interface breaks health-check.service.test.ts createService() fixture (see systemdeps-extension-blast-radius.md)
3. CrudSettingsPage migration is a perfect 1:1 mapping with zero test changes (see crud-settings-page-migration-pattern.md)


## #430 OCP: Settings nav, route, and job auto-registration -- 2026-03-18
**Skill path:** /implement -> /claim -> /plan -> /handoff
**Outcome:** success -- PR #446

### Metrics
- Files changed: 7 | Tests added/modified: 3 new test files, 3 existing updated
- Quality gate runs: 2 (pass on attempt 2 -- first had TypeScript errors from job callback types)
- Fix iterations: 1 (job callback type too narrow for functions returning non-void promises)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean 3-module implementation. All 5809 existing tests passed.
- Friction: vi.mock() hoisting broke App.test.tsx. Job callback types needed widening.

### Token efficiency
- Highest-token actions: Explore subagents for plan and self-review
- Avoidable waste: Elaborate phase had stale ImportListsSettings finding -- cost a spec review round
- Suggestions: Verify subagent defect claims with targeted grep before including in specs

### Infrastructure gaps
- Repeated workarounds: .claude/state/ directory disappearing between steps
- Unresolved debt: scheduleCron/scheduleTimeoutLoop error paths untested (pre-existing)

### Wish I Had Known
1. vi.mock() factories are hoisted above ALL variable declarations
2. Job callback types vary wildly -- use wide return type and cast at registration
3. settingsRegistry (12 schema categories) != settings pages (8 UI routes)

## #431 Code smells: Error utilities, magic numbers, adapter DRY-up — 2026-03-17
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #445

### Metrics
- Files changed: 45+ | Tests added/modified: 24 new tests across 5 files, 6 test files updated
- Quality gate runs: 2 (pass on attempt 2 — first had lint violations from agent work)
- Fix iterations: 2 (lint violations from agent fetchWithTimeout replacement, pre-existing typecheck failure)
- Context compactions: 0

### Workflow experience
- What went smoothly: Modular TDD approach worked well — each utility was self-contained and could be tested independently before sweeping
- Friction / issues encountered: Agent-based sweeps introduced lint violations (unused vi imports, unnecessary return-await) requiring a fix pass. Pre-existing typecheck failure on main (duplicate enrichmentStatusSchema) initially looked like a regression.

### Token efficiency
- Highest-token actions: Explore subagents for codebase exploration and self-review (each reading 30+ files)
- Avoidable waste: Could have combined the route sweep agents (sendInternalError + getErrorMessage) — ran them separately
- Suggestions: For broad mechanical sweeps, include lint rules in agent prompts to avoid fix-up passes

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: Pre-existing typecheck failure on main should have been caught by CI
- Unresolved debt: error-handler.ts now has 11 instanceof blocks (was 6) — registry pattern needed

### Wish I'd Known
1. AbortSignal.timeout() can't be controlled by vi.useFakeTimers() — agents needed to discover this and adapt test mocking strategies independently
2. Typed error class migrations have a guaranteed blast radius in test mocks — every test that mocks the old Error('message') must be updated to the typed class
3. Pre-existing failures on main should be checked first when verify fails — would have saved a debugging cycle



## #435 SRP: Extract orchestration from QualityGateService — 2026-03-18
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #441

### Metrics
- Files changed: 8 | Tests added/modified: 67 (25 new orchestrator + 42 restructured service)
- Quality gate runs: 2 (pass on attempt 2 — lint fix for type import)
- Fix iterations: 1 (self-review caught stale SSE status in auto-reject path)
- Context compactions: 0

### Workflow experience
- What went smoothly: The DownloadOrchestrator/ImportOrchestrator pattern was well-established, making the extraction mechanical.
- Friction: Test fixture types needed all schema fields when calling processDownload() directly vs through untyped mockDbChain.

### Token efficiency
- Highest-token actions: Reading full service test file (881 lines), reading routes/index.ts wiring
- Avoidable waste: Could have derived fixture types from schema upfront
- Suggestions: Create shared complete fixture factories per schema type

### Infrastructure gaps
- Missing tooling: No shared complete-fixture factory for DownloadRow/BookRow
- Unresolved debt: jobs/import.ts is a legacy helper that duplicates jobs/index.ts cron registration

### Wish I'd Known
1. Batch loop objects become stale after atomicClaim — SSE must use statusTransition, not download.status
2. Test fixtures need ALL schema fields when called directly (not through mockDbChain)
3. Spec review rounds were expensive but caught real issues — shared orchestration pattern was already established

## #434 SRP: Extract orchestration from DownloadService — 2026-03-18
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #440

### Metrics
- Files changed: 16 | Tests added/modified: 12 (57 new tests, 9 suites restructured)
- Quality gate runs: 2 (pass on attempt 2 — lint complexity fix)
- Fix iterations: 1 (grab() complexity 18→15 via parseDownloadInput + sendToClient extraction)
- Context compactions: 0

### Workflow experience
- What went smoothly: The ImportOrchestrator from #436 was a perfect template — same constructor pattern, same side-effect helper pattern, same test structure
- Friction / issues encountered: Initially forgot to move the book status DB update to the orchestrator (only moved SSE). The E2E test caught it. Also had to fix complexity in grab() even after stripping side effects.

### Token efficiency
- Highest-token actions: The spec review cycle consumed most context — 3 rounds of elaborate → respond-to-spec-review before the spec was approved
- Avoidable waste: The elaboration wrote test plan bullets from assumptions rather than reading source — caused 2 review rounds of corrections
- Suggestions: For extraction specs, always read actual method implementations before writing test plan bullets

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: monitor.ts has parallel orchestration (direct DB writes + SSE + notifications) — separate from DownloadOrchestrator

### Wish I'd Known
1. Book status DB updates are "consequence" side effects that must move with the SSE/notification side effects — they're not core CRUD (ref: orchestrator-book-status-db-update.md)
2. Stripping side effects from a complex method doesn't always fix the complexity lint — protocol parsing and client wiring alone hit 18 branches (ref: grab-complexity-extraction.md)
3. When side effects are independently guarded, each needs its own try/catch (the safe() pattern) — a single outer try/catch stops all remaining effects when one throws (ref: orchestrator-safe-wrapper-pattern.md)


## #436 SRP: Extract orchestration from ImportService — 2026-03-17
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #439

### Metrics
- Files changed: 15 | Tests added/modified: ~60 (23 new orchestrator, rest restructured)
- Quality gate runs: 3 (pass on attempt 3 — 1st hit max-lines lint, 2nd hit E2E failures from stale callers)
- Fix iterations: 2 (import-steps line limit → extracted to import-side-effects.ts; E2E tests → updated to use orchestrator)
- Context compactions: 0

### Workflow experience
- What went smoothly: The spec was extremely detailed after 4 review rounds — caller matrix, side-effect classification, SSE ownership, test plan. Implementation was mostly mechanical extraction.
- Friction / issues encountered: handleImportFailure mixed core cleanup with side effects — had to split it before the orchestrator could own failure-path dispatch. E2E tests directly called ImportService methods for flows that expect side effects — needed to switch to orchestrator. The 400-line lint limit on import-steps.ts required extracting side-effect functions to a new file.

### Token efficiency
- Highest-token actions: Reading the full import.service.test.ts (1800+ lines) and updating all constructor calls, removing side-effect describe blocks
- Avoidable waste: Could have used a subagent for the import.service.test.ts refactor from the start rather than reading chunks manually first
- Suggestions: For large test file refactors, delegate to a subagent immediately with clear instructions

### Infrastructure gaps
- Repeated workarounds: `.claude/state/` directory keeps disappearing between steps — mkdir -p needed repeatedly
- Missing tooling / config: None
- Unresolved debt: jobs/import.ts is dead code (not imported anywhere), ImportService.getImportContext duplicates queries that importDownload also runs internally

### Wish I'd Known
1. handleImportFailure had mixed concerns (core cleanup + side effects) — splitting it was a prerequisite not obvious from the spec's "stays in ImportService" framing
2. The 400-line lint limit on import-steps.ts would be hit by the new exports — should have extracted to a separate file from the start
3. E2E tests directly instantiate/call service methods — any extraction refactor needs a blast-radius pass on all E2E test files, not just unit tests

## #428 Upgrade to Node 24 — 2026-03-17
**Skill path:** /implement → /claim (already claimed) → /plan (already planned) → /handoff
**Outcome:** success — PR #438

### Metrics
- Files changed: 8 | Tests added/modified: 1 (5 new assertions in s6-service.test.ts)
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Implementation was already complete (4 commits on branch) — handoff was a straight verification pass. All 293 suites / 5593 tests passed immediately. Self-review and coverage review both clean.
- Friction / issues encountered: `.claude/state/` directory kept disappearing between steps (known recurring issue — mkdir -p needed repeatedly). The claim script rejected because the issue was already in-progress, requiring manual phase marker writes.

### Token efficiency
- Highest-token actions: Self-review subagent (~53k tokens) and coverage review subagent (~35k tokens) for what was essentially a verification-only handoff
- Avoidable waste: Both review subagents were overkill for a version-pin-only change with no application logic. Could skip self-review for infra-only issues.
- Suggestions: Consider a lightweight handoff path for chore/infra issues that skips the behavioral review subagents

### Infrastructure gaps
- Repeated workarounds: `.claude/state/` directory disappearing (5th consecutive issue with this problem)
- Missing tooling / config: No lightweight handoff path for trivial chore issues
- Unresolved debt: None introduced or discovered

### Wish I'd Known
1. Alpine 3.21 LSIO baseimage doesn't ship Node 24 packages — must COPY binary from builder stage (see `dockerfile-3stage-alpine-node.md`)
2. When an issue is already claimed and partially implemented, `/implement` should detect this and skip to verification rather than re-claiming
3. The `.claude/state/` directory reliability issue has been present for 5+ issues now — needs a persistent fix (tmpdir? gitignored committed dir?)

## #421 Fix test brittleness — hardcoded counts and missing coverage — 2026-03-17
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #427

### Metrics
- Files changed: 3 | Tests added/modified: 1 new (20 tests), 1 modified
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean 3-commit implementation — each AC mapped to exactly one commit. Full server test suite (92 files, 2307 tests) confirmed zero regressions for the shared helper change.
- Friction / issues encountered: Branch was created from main while HEAD was on the old #422 branch, causing the coverage review subagent to diff against main and pick up #422 changes. Had to explicitly `git checkout` to the correct branch.

### Token efficiency
- Highest-token actions: Coverage review subagent analyzing 10 files from #422 that weren't relevant
- Avoidable waste: Could have verified HEAD was on the correct branch before launching the coverage subagent
- Suggestions: Add a branch verification step at the start of the coverage review subagent prompt

### Infrastructure gaps
- Repeated workarounds: `.claude/state/` directory disappearing between branch switches — had to `mkdir -p` again
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. `readonly (keyof Services)[]` doesn't enforce exhaustiveness — need `satisfies Record<keyof Services, true>` pattern (see `satisfies-exhaustiveness-guard.md`)
2. Branch creation from `/claim` while on a different branch can leave HEAD detached — always verify with explicit checkout (see `branch-divergence-claim-timing.md`)
3. The coverage review subagent diffs against main, so if the branch includes merged commits from another PR, it'll flag those as untested — scope the diff to branch-only commits

## #422 Code hygiene — extract helpers, typed errors, remove stale patterns — 2026-03-17
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #426

### Metrics
- Files changed: 13 | Tests added/modified: 7
- Quality gate runs: 3 (pass on attempt 3)
- Fix iterations: 2 (1: lint issues from route simplification + error-handler complexity; 2: typecheck failure from untyped emitSSE + module-scope getTableColumns breaking transitive test mock)
- Context compactions: 0

### Workflow experience
- What went smoothly: AC3 (stale re-exports) was trivial. AC2 typed error pattern was well-established in the codebase — copy/adapt was fast. AC1 extraction hit the line target cleanly.
- Friction / issues encountered: AC4's `getTableColumns` at module scope broke tagging.service.test.ts through a transitive import chain (services/index.ts). Had to make the call lazy. Also needed to fix the tagging test's shallow drizzle-orm mock to use `importOriginal`.

### Token efficiency
- Highest-token actions: Coverage review subagent (exhaustive, read all test files)
- Avoidable waste: Could have anticipated the module-scope issue with getTableColumns before running verify
- Suggestions: When adding module-scope calls to shared utility imports, grep for partial mocks of that module first

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: error-handler.ts complexity growing linearly (6 blocks, eslint-disable); tagging.service.test.ts shallow mock pattern is fragile

### Wish I'd Known
1. `getTableColumns()` at module scope will break any test that partially mocks `drizzle-orm` through transitive imports — use lazy evaluation
2. Removing try/catch from route handlers also requires removing `return await` (eslint `return-await` rule) and the unused `reply` parameter
3. The `emitSSE` helper must preserve the broadcaster's generic type constraint — `string` won't satisfy `SSEEventType`

## #418 Extract shared SuggestionReason registry — 2026-03-17
**Skill path:** /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #424

### Metrics
- Files changed: 11 | Tests added/modified: 1 (6 new tests)
- Quality gate runs: 2 (pass on attempt 2 — first failed due to removed eslint-disable)
- Fix iterations: 2 (eslint-disable restoration, hardcoded settings default)
- Context compactions: 0

### Workflow experience
- What went smoothly: Pure refactor with clear scope — all existing tests passed unchanged after the swap. The download-status-registry pattern provided a clear template.
- Friction / issues encountered: Self-review caught a hardcoded `.default()` literal in settings schema that the implementation missed. The `eslint-disable max-lines` comment was accidentally removed when editing the first line of discovery.service.ts.

### Token efficiency
- Highest-token actions: Explore subagents for plan and coverage review
- Avoidable waste: Could have kept the eslint-disable on first edit instead of removing and re-adding
- Suggestions: When editing a file's first line, check for file-level eslint directives first

### Infrastructure gaps
- Repeated workarounds: `.claude/state/` directory keeps getting lost between steps (mkdir -p needed repeatedly)
- Missing tooling / config: None
- Unresolved debt: discovery-weights.ts formula lacks dedicated unit tests; discovery.service.ts still over max-lines

### Wish I'd Known
1. When deriving Zod object shapes dynamically, the `.default()` value must ALSO be derived — easy to miss (see `zod-object-fromEntries-default.md`)
2. Removing a line that happens to be an `eslint-disable` breaks lint even if the underlying violation hasn't changed (see `eslint-disable-removal-trap.md`)
3. The `SUGGESTION_REASONS` array type from `z.enum().options` is already a readonly tuple — no need to re-annotate it (caused a TS error on first attempt)

## #404 Discover — Series Completion Intelligence — 2026-03-17
**Skill path:** /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #420

### Metrics
- Files changed: 1 | Tests added/modified: 16
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (two test assertions needed reason-filter refinement due to dedup map behavior)
- Context compactions: 0

### Workflow experience
- What went smoothly: Pure validation issue — all code existed from #366, just needed test coverage. Quick turnaround.
- Friction / issues encountered: 3 rounds of spec review ping-pong on fractional position worked example before approval. During test implementation, 2 of 16 tests failed initially because the candidate dedup map means author queries can "steal" candidates from series queries when author scores higher.

### Token efficiency
- Highest-token actions: Spec review response rounds (3 rounds), codebase exploration for plan
- Avoidable waste: The spec review could have been resolved in 1 round if the original fractional-position example had been traced step-by-step through the loop
- Suggestions: When writing worked examples for loops, always trace actual variable values (init, increment, each iteration)

### Infrastructure gaps
- Repeated workarounds: `.claude/state/` directories disappearing between steps (had to mkdir -p again)
- Missing tooling / config: None
- Unresolved debt: None new — all pre-existing debt items remain unchanged

### Wish I'd Known
1. The `generateCandidates` dedup map means `queryAuthorCandidates` runs first and can claim ASINs with `reason: 'author'` before `querySeriesCandidates` gets to them — always filter by `reason` in series-specific assertions (see `series-dedup-map-reason-override.md`)
2. `computeSeriesGaps()` loop inherits the fractional part from `Math.min(...)` — `for (let i = 1.5; ...)` increments to 2.5, never hitting integer 2 (see `fractional-loop-counter-trace.md`)
3. This issue was 100% validation work — the spec review took longer than the actual implementation

## #406 Discover — Dismissal Tracking and Score Weight Tuning — 2026-03-17
**Skill path:** /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #419

### Metrics
- Files changed: 10 | Tests added/modified: 31
- Quality gate runs: 2 (pass on attempt 2 — first had max-lines lint violation)
- Fix iterations: 1 (extracted pure functions to discovery-weights.ts, fixed form TS type)
- Context compactions: 0

### Workflow experience
- What went smoothly: TDD cycle worked well — each module had clear red→green phases. The pure function extraction (computeWeightMultipliers) made testing the formula trivially easy.
- Friction / issues encountered: Mock chain ordering was the biggest friction — adding one DB query to refreshSuggestions shifted all existing test mock chains. Had to manually update 9 existing tests. Also hit a TypeScript error from the shared schema change propagating to the frontend form component.

### Token efficiency
- Highest-token actions: Explore subagent for codebase exploration, coverage review subagent
- Avoidable waste: Could have predicted the mock chain shift upfront and batched the fixture updates
- Suggestions: When adding a new DB query to a multi-query method, immediately enumerate all tests that mock that method's call chain

### Infrastructure gaps
- Repeated workarounds: Manual mock chain ordering in refreshSuggestions tests — a test helper that names mock returns by purpose (not position) would be more resilient
- Missing tooling / config: No way to test formula edge cases without going through the full service constructor — extracting to pure functions was the right call
- Unresolved debt: discovery.service.ts still over max-lines (added eslint-disable)

### Wish I'd Known
1. Adding a new db.select() call to refreshSuggestions would break ALL existing refresh tests due to mock chain ordering — should have enumerated affected tests before writing new ones
2. Shared settings schema changes propagate to frontend form components via TypeScript — the form type should derive from the form schema, not the full settings type
3. The max-lines lint violation was pre-existing (452 lines on main, limit 400) — discovery.service.ts already needed extraction before this issue

## #407 Discover — Diversity Factor (Filter Bubble Prevention) — 2026-03-17
**Skill path:** /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #417

### Metrics
- Files changed: 8 | Tests added/modified: 18
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (mock isolation for diversity vs affinity queries in service tests)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was well-defined after 3 rounds of review. The existing query*Candidates pattern made implementation straightforward — copy queryGenreCandidates, swap genre selection logic. No schema migration needed.
- Friction / issues encountered: Test mock isolation — blanket searchBooksForDiscovery mocks let affinity queries claim diversity ASINs first, causing 3 test failures. Required per-query-string mockImplementation to isolate affinity vs diversity search results.

### Token efficiency
- Highest-token actions: Self-review and coverage review subagents (~150k tokens combined)
- Avoidable waste: Spec review response (round 2) was called before /implement, costing an extra issue read cycle
- Suggestions: For additive enum changes, the self-review subagent is overkill — most findings are "correct" with no bugs to catch

### Infrastructure gaps
- Repeated workarounds: .claude/state/ directory sometimes gets cleaned up between steps, requiring mkdir -p
- Missing tooling / config: No shared SuggestionReason type — 8-file enum duplication is the biggest DX pain point in the discover feature area
- Unresolved debt: SuggestionReason enum duplication (see debt.md)

### Wish I'd Known
1. **Mock isolation is critical for multi-signal pipelines**: When testing diversity through generateCandidates(), affinity queries (author, genre, series, narrator) all call the same searchBooksForDiscovery mock — a blanket mock lets them steal diversity ASINs. Always use mockImplementation with query-string matching. (see learnings/diversity-mock-isolation.md)
2. **SQLite text enum changes are metadata-only**: No migration needed — saves a step in the workflow
3. **The existing filterAndScore() helper is fully generic**: It accepts any SuggestionReason, so diversity candidates flow through the same quality filter path as affinity candidates without any modification

## #408 Discover — Suggestion Lifecycle (Expiry, Snooze, Re-score) — 2026-03-17
**Skill path:** /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #416

### Metrics
- Files changed: 14 | Tests added/modified: 34
- Quality gate runs: 3 (pass on attempt 3 — lint violation then typecheck error)
- Fix iterations: 2 (unused param lint, union type narrowing in test)
- Context compactions: 0

### Workflow experience
- What went smoothly: Module-by-module TDD cycle was clean — each module took 1 red/green pass. The mock helpers (createMockSettings deep merge, Proxy-based createMockServices) handled new fields automatically. Spec review response + implementation ran end-to-end without blocking.
- Friction / issues encountered: mockDbChain error simulation required `{ error: ... }` option, not a thrown function — burned a test iteration. Self-review caught snoozeUntil not being cleared on resurface, which would have been a blocking review finding.

### Token efficiency
- Highest-token actions: Explore subagent for codebase exploration (~85k tokens), coverage review subagent (~88k tokens)
- Avoidable waste: Could have skipped reading some test files in parallel since the patterns are consistent
- Suggestions: For issues with many modules but simple patterns, batch similar modules (e.g., client API + client test in one pass)

### Infrastructure gaps
- Repeated workarounds: Drizzle delete() result type casting for rowsAffected
- Missing tooling / config: No typed return from Drizzle delete operations
- Unresolved debt: computeResurfacedScore heuristic, SuggestionRow client/server duplication

### Wish I'd Known
1. **snoozeUntil must be cleared on resurface** — temporal fields that act as filters need lifecycle management. If a field controls visibility and its condition becomes permanently true, you get an infinite loop. Self-review caught this but a test would have been better.
2. **mockDbChain error injection uses `{ error }` option, not thrown functions** — the Proxy-based chain resolves promises, so you need Promise.reject not synchronous throws.
3. **Union type narrowing in tests** — when a service returns `T | 'conflict' | null`, TypeScript needs explicit narrowing before accessing properties on `T`. Use `if (result && result !== 'conflict')` guards.
