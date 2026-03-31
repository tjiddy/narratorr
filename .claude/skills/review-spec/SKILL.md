---
name: review-spec
description: Review an elaborated spec for gaps, missing test plans, and codebase
  assumption errors. Posts structured findings with approve/needs-work verdict. Use
  when user says "review spec", "check spec", or invokes /review-spec.
argument-hint: <issue-id>
disable-model-invocation: true
hooks:
  Stop:
    - hooks:
        - type: command
          command: "node scripts/hooks/stop-gate.ts review-spec"
---

!`cat .claude/docs/testing.md`

!`cat .claude/docs/design-principles.md`

!`cat .claude/docs/architecture-checks.md`

# /review-spec <id> — Review an issue spec for gaps and quality

Reviews an elaborated issue spec with fresh eyes. Explores the codebase exhaustively to validate assumptions, find gaps, and suggest improvements. Posts structured findings as a comment. Sets `status/ready-for-dev` on approve, `status/fixes-spec` on needs-work.

**This skill must be run by a different agent than the one that wrote the spec.**

**Review policy: high recall.** Prefer false positives over missed defects. The cost of a spec author dismissing a noisy suggestion is far lower than the cost of a missed gap reaching implementation. Do not cap the number of findings — report everything you find. Use `suggestion` liberally for anything that *might* matter; reserve `blocking` strictly for issues that would cause implementation failure, incorrect behavior, or untestable requirements.

## Guardrails

**This skill is READ-ONLY.** Never stage, commit, or modify any files outside of `.narratorr/cl/` and `.narratorr/state/` (aliased as `.agents/cl/` and `.agents/state/` in some clones). The reviewer does not edit specs — it reports findings for the author to address. If you find yourself editing issue bodies, source files, or anything under `src/`, STOP — you are doing the author's job.

**Do NOT run tests, builds, or linting locally.** `node_modules` is not available in detached worktrees and `pnpm exec` will fail. This review is static analysis only — read code and diffs, do not execute anything. CI handles test execution.

## GitHub CLI

All GitHub commands use: `node scripts/gh.ts` (referred to as `gh` below).

## Steps

0. **Initialize stop-gate state:** `mkdir -p .narratorr/state/review-spec-<id>/`

0b. **Ensure latest codebase:** Run `git checkout main && git pull` before starting. Spec reviews validate assumptions against the codebase — a stale checkout produces false findings.

1. **Read the issue:** Run `node scripts/gh.tsissue view <id> --json number,state,title,labels,milestone,body --jq '"#\(.number) [\(.state | ascii_downcase)] \(.title)\nlabels: \([.labels[].name] | join(", "))\(.milestone.title // "" | if . != "" then " | milestone: \(.)" else "" end)\n\n\(.body // "")"'`. Extract:
   - Title, labels
   - Full issue body (spec)
   - Existing comments (prior review findings, elaboration notes)

2. **Parse prior review history (re-reviews only):** From the comments extracted in step 1, find all comments containing `## Spec Review` (prior reviews) and `## Spec Review Response` (author responses). Build a map of prior findings and their resolutions:
   - For each prior finding ID (F1, F2, etc.), note: the original finding, the author's resolution (`fixed`, `accepted`, `disputed`), and any rationale provided.
   - If this is the first review (no prior `## Spec Review` comments), skip to step 3.
   - **This does NOT reduce the scope of the review.** Steps 3-5 still run in full — you may find net-new issues that prior rounds missed. The prior history only affects how you handle findings that overlap with previously-disputed items (see dispute engagement rules below).

   **Dispute engagement rules** — these apply in step 6 when classifying findings. After completing the full review (steps 3-5), check each finding against the prior history map:
   - If a finding was previously raised and the author **fixed** it (updated the spec), verify the update addresses the issue. If it does, drop the finding. If the fix is incomplete, raise a NEW finding explaining what's still wrong.
   - If a finding overlaps with something the author previously **disputed** with rationale, you MUST engage with their specific argument before re-raising it:
     1. **Withdraw** — the author's rationale is correct. Drop the finding.
     2. **Rebut** — the author's rationale is wrong. Raise the finding with a NEW reason that directly refutes their argument.
     3. **Refine** — the author's rationale is partially correct. Raise a narrower finding that accounts for their point.
   - **Re-raising a finding with the same description and reason after it was disputed is NOT allowed.** If you can't rebut the author's specific argument, withdraw. Repeating yourself is not reviewing — it's a defect.
   - **Re-read before re-raising:** Before re-raising ANY finding, re-read the current spec body and relevant source files to verify the concern still exists. Do not rely on cached context from a prior round — the author may have fixed it.
   - If a finding was previously **accepted** or **deferred**, it's resolved — don't re-raise.
   - **Net-new findings are always welcome** regardless of prior history.

3. **Read project context:**
   - Read `CLAUDE.md` for design principles, testing standards, project philosophy, and architecture patterns

4. **Explore the codebase** via an Explore subagent (keeps exhaustive file reads out of main context):

   Launch an **Explore subagent** (Agent tool, `subagent_type: "Explore"`, thoroughness: "very thorough") with this prompt:

   > Exhaustively explore the codebase relevant to issue #<id>: "<issue title>".
   > Scope labels: <labels>. Key areas from spec: <summarize AC and implementation hints>.
   >
   > **IMPORTANT: Show your work.** Every claim must include evidence — the search queries you ran, the files you read, the line numbers you found. Conclusions without receipts are unacceptable; providing proof forces thorough investigation.
   >
   > Be thorough — most high-value review findings come from discovering the spec's assumptions don't match reality.
   >
   > 1. Find existing code that the spec will touch or extend
   > 2. Understand current patterns, interfaces, and data flow in the affected areas
   > 3. Identify existing tests in the area to understand coverage patterns
   > 4. Check for related features that might interact or conflict
   > 5. Look for prior art — has something similar been built elsewhere in the codebase?
   > 6. Run `node scripts/gh.tspr list --state open --limit 50 --json number,state,title,headRefName,baseRefName,url --jq '.[] | "#\(.number) [\(.state | ascii_downcase)] \(.title)\n   \(.headRefName) → \(.baseRefName) | \(.url)"'` to check for conflicting open PRs
   > 7. **Verify named artifacts:** If the spec names specific files to create, modify, or delete (especially cleanup targets like learning files, debt entries, config files), verify each one exists using `ls` or `git ls-files`. For files claimed to be gitignored/local-only, verify with `git check-ignore <path>`. Report any named-but-missing artifacts.
   > 8. **Mechanical artifact grep (CRITICAL):** Extract EVERY API endpoint, schema field/column, settings key, service method, and file path referenced anywhere in the spec body. For each one, verify it exists in the codebase with the type/signature the spec assumes. Use grep/read to confirm. Return a table: `| Artifact | Spec Claim | Codebase Reality | Match? |`. This is the single highest-value check — specs that reference nonexistent endpoints or wrong field types are the #1 cause of multi-round review cycles.
   > 9. **Verify out-of-scope claims:** If the spec has a "Scope Boundaries", "Out of scope", or equivalent section, extract every claim that something is "already fixed", "already handled", or "not needed because X". Verify each against the codebase — grep for the relevant code, read it, confirm the claim is true. Report any false claims. An unverified "already fixed" claim has caused bugs to ship as "done" without being fixed.
   >
   > Return this structure:
   > ```
   > EXISTING CODE: <files/modules the spec will touch, with key interfaces and types>
   > PATTERNS: <current patterns and data flow in the affected areas>
   > TEST COVERAGE: <existing tests in the area, what's covered>
   > RELATED FEATURES: <features that might interact or conflict>
   > PRIOR ART: <similar implementations elsewhere in the codebase>
   > CONFLICTING PRS: <open PRs in the same area, or "none">
   > SPEC ASSUMPTION RISKS: <anything in the codebase that contradicts or complicates spec assumptions>
   > NAMED ARTIFACTS: <for each file the spec names as a cleanup/creation/deletion target: exists | missing | gitignored (with git check-ignore result)>
   > ASSUMPTION COVERAGE: <table/list mapping each AC assumption to verified code evidence path:line, or "unverified">
   > ```

   Use the subagent's output to inform the spec evaluation in step 5.

5. **Evaluate the spec** against these checklists:

   **Precision checks:**
   - Every AC item is testable — could you write a pass/fail test from the AC alone?
   - AC items don't contradict each other
   - No undefined terms — if the spec references a concept, it's defined or linked to existing code
   - No ambiguous language ("should work correctly", "handles appropriately", "as expected")
   - Scope boundaries are explicit — what's NOT included is stated

   **Completeness checks:**
   - Each user interaction (if present) has a corresponding AC item
   - Each AC item maps to at least one testable behavior
   - Error states are specified — what happens when each operation fails?
   - Edge cases are identified — empty states, boundary values, concurrent operations
   - Data flow is traceable — where does input come from, where does output go?
   - **Core design contracts:** For features involving feed/event processing, matching, or synchronization, verify the spec defines the item-to-entity matching contract (scoring, thresholds, tie-breaking, dedup). For features involving concurrency, verify the spec defines the concurrency model (locks, queues, semaphores) and which entry points are covered. These are the most expensive questions to defer — catching them in round 4 instead of round 1 wastes 3 full review cycles.
   - **Policy exhaustiveness:** When a spec defines a classification/disposition policy (audit triage, error categorization, state machine transitions), enumerate every combination the real data can produce and verify each one has a defined outcome. Don't just check the cases the spec mentions — check for cases it *doesn't* mention. Run the actual command (`pnpm audit --json`, `pnpm outdated`, etc.) and walk every row against the policy. If any row falls through the cracks, that's a finding.

   **Codebase alignment checks:**
   - Assumptions about existing code are accurate (APIs exist, types match, patterns are followed)
   - Proposed approach follows existing patterns or explicitly justifies divergence
   - Dependencies are real — referenced issues/features actually exist and are in the expected state
   - No conflicts with in-progress work (check open PRs via `node scripts/gh.tspr list`)
   - **Mechanical artifact grep (MANDATORY):** Extract every API endpoint (e.g., `GET /api/settings`), schema field (e.g., `bookEvents.createdAt`), settings key (e.g., `general.logLevel`), service method (e.g., `BlacklistService.deleteExpired()`), and file path (e.g., `src/server/jobs/blacklist-cleanup.ts`) referenced in the spec. Grep or read the codebase to confirm each one exists and has the type/signature the spec assumes. Flag any that don't exist or don't match as `blocking` with category `alignment`. This is the #1 source of multi-round spec review cycles — specs reference artifacts that don't exist or have different signatures, and catching them all in round 1 saves 1-2 full review rounds.
   - **Caller surface audit:** When the spec modifies a shared service method or interface, grep for ALL callers of that method. Verify the spec covers each caller's usage. A spec that changes `getBlacklistedHashes()` but only considers the search caller while ignoring the retry-search and RSS callers has a gap. This is the #1 source of avoidable spec review ping-pong.
   - **Schema/field name verification:** Cross-check every DB column, API endpoint, field name, and status literal mentioned in the spec against the actual schema (`src/db/schema.ts`), routes, and types. If the spec references `updatedAt` but the table only has `createdAt`, that's a blocking finding. Do not assume field names are correct — verify them.
   - **Blast radius scan:** When the spec adds or modifies types, schema fields, or service interfaces, grep for existing test mocks that reference those types. List any test files that hardcode objects of the affected types — these will need mock updates during implementation. Flag in findings as `category: "blast-radius"` severity `suggestion` if more than 2 test files are affected.
   - **Error propagation check:** When the spec introduces a new error type or changes error handling, trace the call chain from where the error is thrown to where it's caught. Flag any catch-all blocks (`catch { return null }`, `catch (e) { return [] }`, etc.) that would silently swallow the new error. This is a `category: "error-propagation"` finding, severity `blocking` if the error would be silently swallowed.
   - **Named artifact verification:** When ACs reference specific files to create, modify, or delete, verify each named file exists in the working tree. For files claimed to be gitignored or local-only, verify with `git check-ignore <path>`. If a named artifact doesn't exist, the AC must use conditional language ("if file exists...") or be flagged as `blocking`.
   - **Out-of-scope claim verification (MANDATORY):** When the spec has a "Scope Boundaries", "Out of scope", or equivalent section that claims something is "already fixed", "already handled", or "not needed because X", verify EACH claim against the codebase. Grep for the relevant code, read it, and confirm the claim is true. An unverified "already fixed on main" claim is indistinguishable from a hallucination — and has caused bugs to ship as "done" without being fixed. Flag any false out-of-scope claim as `blocking` with category `scope-claim`. If the claim is true, note it as verified in the assumption coverage table.

   **Design checks (from `.claude/docs/architecture-checks.md` + CLAUDE.md):**
   - **OCP-1 (Wiring Cost):** Does the spec describe adding a new type variant? Based on codebase exploration, how many files would need type-registration edits? If >3, flag it and suggest a registry pattern.
   - **OCP-2 (Growing Switch):** Does the spec implicitly require adding a case to an existing switch/factory? Note the current case count.
   - **LSP-1 (Interface Contract):** Does the spec describe behavior that would violate an interface contract (e.g., returning null where siblings return data, no-op implementations)?
   - **DRY-1 (Parallel Types):** Would the spec require adding the same type literal to 4+ files?
   - SRP: Does the plan keep single responsibility per file? Or does it add a second concern to existing files?
   - DRY: Does the plan duplicate a pattern that already exists? Should it reuse or extract a shared component/hook/service?
   - Co-location: Are new types/components landing next to the code that uses them?

   **Test plan checks:**
   - Test plan exists and covers each AC item
   - Test approach matches the project's testing conventions (co-located, mock at API boundary, userEvent for interactive components)
   - Error paths have planned test coverage
   - Test plan doesn't propose testing implementation details (CSS classes, internal state)

   **Behavioral accuracy (test specs only):**
   - When the issue's primary deliverable is tests (not features), and the spec describes existing code behavior that tests should verify, read the actual source code and confirm the spec's description matches reality.
   - Flag any mismatch between described behavior and actual implementation as `category: "behavioral-accuracy"`, severity `blocking`. Example: spec says "hook implements optimistic updates" but the hook only invalidates queries on success.
   - Skip this check for feature/bug issues where the spec describes *new* behavior to implement.

   **Exhaustiveness gate (MANDATORY):**
   - Build an **Assumption Coverage** table that lists:
     - each AC item,
     - each material implementation assumption in the spec (APIs, data shapes, jobs, UI states, error contracts),
     - evidence (`path:line`), or `unverified`.
   - **Granularity rule:** Split assumptions and gaps by independently falsifiable claim. Do not collapse multiple open questions into one broad finding like "test plan is incomplete" or "defaults are unclear" if the missing details can be named separately. If a spec touches save behavior, error handling, and cache updates, enumerate those as separate assumptions/gaps unless one piece of evidence truly proves them together.
   - Any `unverified` assumption is a review defect and MUST produce a finding:
     - `blocking` when the assumption affects correctness/implementability,
     - `suggestion` when it is non-critical scope/polish.
   - Do not move to step 6 until every AC item and material assumption is represented in this table.

6. **Classify findings** — For every issue found, create a finding with severity. Do not cap the number of findings — report everything you find.
   - **`"blocking"`**: Spec cannot be implemented correctly without addressing this. Missing AC, contradictions, wrong assumptions about existing code, untestable requirements. Blocking findings must be evidence-based — point to a specific spec line and a specific codebase fact that conflicts, or a concrete scenario that the spec fails to handle.
   - **`"suggestion"`**: Would improve the spec but not strictly required. Use liberally across these categories: edge case coverage, alternative approaches, pattern improvements, test-quality gaps, maintainability concerns, observability/logging gaps, naming clarity, and future regression risk.
   - Every finding MUST include a concrete "why" and ideally a proposed fix or question to resolve it.
   - Cross-check with Assumption Coverage table: every `unverified` row must have a corresponding finding.
   - **No umbrella findings:** If a broad finding could be "addressed" while leaving another nearby assumption in the same AC or test-plan area unresolved, split it into smaller findings or refine it until the remaining gap is explicit. The author should be able to resolve exactly what is written without guessing what else the reviewer meant.
   - **Ping-pong check:** Before finalizing a blocking finding, ask: "If the spec author updated only the text I called out, could another unmentioned assumption in the same area still remain ambiguous or wrong?" If yes, the finding is too coarse and should be refined or split before posting.
   - **Enumerate, don't summarize:** When a finding says data in the spec is wrong or stale (audit tables, version numbers, parent paths, field names, file lists), list every specific row/claim that is wrong and what the correct value is. "Refresh this table" is an umbrella finding — the author will regenerate sloppily and you'll re-raise the same finding next round with a narrower scope. Instead: "Row X says parent is Y but audit shows Z; row A is missing entirely; row B lists the wrong severity." Give the author a punch list, not a vague direction.
   - **Exhaust the category:** When you find one instance of a problem pattern (e.g., one wrong audit path, one missing policy case, one untested endpoint), actively look for MORE instances of the same pattern before writing the finding. A finding that says "the rollup path is wrong" when ajv and minimatch paths are also wrong will bounce back. Sweep the full surface once so you can write one comprehensive finding instead of discovering siblings in round 2.

6b. **Write phase marker:** `mkdir -p .narratorr/state/review-spec-<id> && echo done > .narratorr/state/review-spec-<id>/review-complete`

7. **Determine verdict:**
   - **`approve`**: Zero blocking findings. Spec is ready for implementation.
   - **`needs-work`**: One or more blocking findings. Spec needs updates before claiming.

8. **Post review comment AND set labels (both are MANDATORY GitHub API calls — do not skip either):**

   **8a. Post the review comment:**
   - Write comment to temp file, then: `node scripts/gh.tsissue comment <id> --body-file <temp-file-path>`
   - **Verify the comment was posted** — the command should return the comment ID. If it fails, retry once.
   - Template:
     ```
     ## Spec Review

     ### Precision
     - Testable AC: pass | issues (<details>)
     - Unambiguous language: pass | issues (<details>)
     - Scope boundaries: present | missing

     ### Completeness
     - Error states: covered | gaps (<details>)
     - Edge cases: covered | gaps (<details>)
     - Data flow: traceable | unclear (<details>)

     ### Codebase Alignment
     - Assumptions verified: pass | issues (<details>)
     - Pattern consistency: pass | divergence (<details>)
     - Conflicts: none | <PR links or issue refs>
     - Blast radius: clean | <N test files affected> (<details>)
     - Error propagation: clean | swallowed (<details>)

     ### Assumption Coverage
     - Assumption coverage: complete | incomplete
     - AC/assumption evidence table:
       | Item | Evidence |
       |------|----------|
       | AC1: <short text> | src/server/foo.ts:42 |
       | AC2: <short text> | unverified |
       | Assumption: <API returns X> | src/shared/schema.ts:18 |

     ### Design
     - SRP: pass | concern (<details>)
     - DRY: pass | concern (<details>)
     - Open/Closed: pass | concern (<details>)

     ### Test Plan
     - Coverage: pass | gaps (<details>)
     - Approach: pass | issues (<details>)
     - Behavioral accuracy: pass | mismatch (<details>) | N/A (not a test spec)

     ## Prior Findings (omit on first review)

     | Prior ID | Original Description | Disposition |
     |----------|---------------------|-------------|
     | F1 (round 1) | <description> | verified-fixed / withdrawn / re-raised as F<N> (rebuttal: <why author's argument doesn't hold>) |

     ## Verdict: approve | needs-work

     <Summary — what's strong about the spec, what needs to change>

     ## Findings

     ```json
     [
       {
         "id": "F1",
         "severity": "blocking",
         "category": "precision|completeness|alignment|design|test-plan|blast-radius|error-propagation|behavioral-accuracy",
         "description": "Short description of the issue",
         "reason": "Concrete why — what breaks or what's missing",
         "suggestion": "Proposed fix or question to resolve"
       }
     ]
     ```
     ```
   - Clean up temp file

   **8b. Set labels based on verdict (the orchestrator depends on these — skipping this breaks the pipeline):**

   Read the issue's current labels from step 1. Then:

   **If `approve`:**
   - Run: `node scripts/update-labels.ts <id> --replace "status/" "status/ready-for-dev"`
   - Verify the output shows `status/ready-for-dev`. If it doesn't, STOP and report the error.

   **If `needs-work`:**
   - Run: `node scripts/update-labels.ts <id> --replace "status/" "status/fixes-spec"`
   - Verify the output shows `status/fixes-spec`. If it doesn't, STOP and report the error.

   **You are NOT done until BOTH 8a and 8b have executed.** Posting the comment without setting the label leaves the issue in a dead state — the orchestrator will never pick it up.

9. **Write final phase marker and clean up:** `mkdir -p .narratorr/state/review-spec-<id> && echo done > .narratorr/state/review-spec-<id>/posted`
    - Then clean up state: `rm -rf .narratorr/state/review-spec-<id>/`

11. **Report:** Summary of verdict and key findings.

## Important

- This skill is for **reviewing** specs, not writing them. Never modify the issue body — only leave comments.
- Findings should be actionable. "This could be better" is not a finding. "AC item 3 says 'handles errors' but doesn't specify what the user sees when the API returns 500" is a finding.
- The codebase exploration in step 4 is critical — most high-value findings come from discovering that the spec's assumptions don't match reality. Don't skip or shortcut it.
- An `approve` verdict means zero blocking findings. Any blocking finding → `needs-work`.
- Blocking findings require concrete evidence — a specific spec statement that conflicts with a specific codebase fact, or a concrete scenario that would fail. "This might cause issues" is not blocking; "AC 2 assumes `getBook()` returns narrators but it doesn't — see `services/book.ts:45`" is blocking.
- Use suggestions liberally. When in doubt about severity, make it a suggestion — the spec author can promote it if they agree it matters.
- If there are no findings at all, use an empty array: `[]`
- You cannot approve a spec with incomplete assumption coverage. If any material assumption remains `unverified`, verdict must be `needs-work` unless it is explicitly made non-blocking and tracked as a suggestion with rationale.
- Consult the project's CLAUDE.md philosophy section — optimize findings for defect prevention, not compliance.
- Broad findings create review ping-pong. Prefer several precise findings over one vague finding whenever different assumptions could be corrected independently.
- **Re-reviews require prior comment reading.** On any issue that already has `## Spec Review` comments, step 2 is mandatory. Skipping it produces review loops where the same finding bounces back and forth.
- **Stand your ground when you're right.** If the author disputes a finding and their rationale is wrong, rebut it with specific evidence. Don't withdraw just because they pushed back — withdraw because they proved you wrong. But if they DID prove you wrong, have the intellectual honesty to drop it.
