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
        - type: prompt
          prompt: "The agent is running /review-spec (explore codebase → evaluate spec → post review comment → set labels). Check its last message. It is DONE only if it confirms BOTH the review comment was posted to Gitea AND labels were updated (status/ready-for-dev or status/fixes-spec), and includes '### Assumption Coverage' with 'Assumption coverage: complete', or an explicit STOP/block condition. If the last message has review findings but no confirmation of posting to Gitea/updating labels, or lacks assumption coverage completion, respond {\"ok\": false, \"reason\": \"Spec review incomplete. You must prove assumption coverage, post the review comment to Gitea, and update labels before stopping.\"}. If complete or blocked, respond {\"ok\": true}."
---

!`cat .claude/docs/testing.md`

!`cat .claude/docs/design-principles.md`

!`cat .claude/docs/architecture-checks.md`

# /review-spec <id> — Review an issue spec for gaps and quality

Reviews an elaborated issue spec with fresh eyes. Explores the codebase exhaustively to validate assumptions, find gaps, and suggest improvements. Posts structured findings as a comment. Sets `status/ready-for-dev` on approve, `status/fixes-spec` on needs-work.

**This skill must be run by a different agent than the one that wrote the spec.**

**Review policy: high recall.** Prefer false positives over missed defects. The cost of a spec author dismissing a noisy suggestion is far lower than the cost of a missed gap reaching implementation. Do not cap the number of findings — report everything you find. Use `suggestion` liberally for anything that *might* matter; reserve `blocking` strictly for issues that would cause implementation failure, incorrect behavior, or untestable requirements.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

0. **Ensure latest codebase:** Run `git checkout main && git pull` before starting. Spec reviews validate assumptions against the codebase — a stale checkout produces false findings.

1. **Read the issue:** Run `gitea issue <id>`. Extract:
   - Title, labels, milestone
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
   - **Re-raising a finding with the same description and reason after it was disputed is NOT allowed.** If you can't rebut the author's specific argument, withdraw. Repeating yourself is not reviewing.
   - If a finding was previously **accepted** or **deferred**, it's resolved — don't re-raise.
   - **Net-new findings are always welcome** regardless of prior history.

3. **Read project context:**
   - Read `CLAUDE.md` for design principles, testing standards, project philosophy, and architecture patterns

4. **Explore the codebase** via an Explore subagent (keeps exhaustive file reads out of main context):

   Launch an **Explore subagent** (Agent tool, `subagent_type: "Explore"`, thoroughness: "very thorough") with this prompt:

   > Exhaustively explore the codebase relevant to issue #<id>: "<issue title>".
   > Scope labels: <labels>. Key areas from spec: <summarize AC and implementation hints>.
   >
   > Be thorough — most high-value review findings come from discovering the spec's assumptions don't match reality.
   >
   > 1. Find existing code that the spec will touch or extend
   > 2. Understand current patterns, interfaces, and data flow in the affected areas
   > 3. Identify existing tests in the area to understand coverage patterns
   > 4. Check for related features that might interact or conflict
   > 5. Look for prior art — has something similar been built elsewhere in the codebase?
   > 6. Run `node scripts/gitea.ts prs` to check for conflicting open PRs
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

   **Codebase alignment checks:**
   - Assumptions about existing code are accurate (APIs exist, types match, patterns are followed)
   - Proposed approach follows existing patterns or explicitly justifies divergence
   - Dependencies are real — referenced issues/features actually exist and are in the expected state
   - No conflicts with in-progress work (check open PRs via `gitea prs`)
   - **Blast radius scan:** When the spec adds or modifies types, schema fields, or service interfaces, grep for existing test mocks that reference those types. List any test files that hardcode objects of the affected types — these will need mock updates during implementation. Flag in findings as `category: "blast-radius"` severity `suggestion` if more than 2 test files are affected.
   - **Error propagation check:** When the spec introduces a new error type or changes error handling, trace the call chain from where the error is thrown to where it's caught. Flag any catch-all blocks (`catch { return null }`, `catch (e) { return [] }`, etc.) that would silently swallow the new error. This is a `category: "error-propagation"` finding, severity `blocking` if the error would be silently swallowed.

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
   - Any `unverified` assumption is a review defect and MUST produce a finding:
     - `blocking` when the assumption affects correctness/implementability,
     - `suggestion` when it is non-critical scope/polish.
   - Do not move to step 6 until every AC item and material assumption is represented in this table.

6. **Classify findings** — For every issue found, create a finding with severity. Do not cap the number of findings — report everything you find.
   - **`"blocking"`**: Spec cannot be implemented correctly without addressing this. Missing AC, contradictions, wrong assumptions about existing code, untestable requirements. Blocking findings must be evidence-based — point to a specific spec line and a specific codebase fact that conflicts, or a concrete scenario that the spec fails to handle.
   - **`"suggestion"`**: Would improve the spec but not strictly required. Use liberally across these categories: edge case coverage, alternative approaches, pattern improvements, test-quality gaps, maintainability concerns, observability/logging gaps, naming clarity, and future regression risk.
   - Every finding MUST include a concrete "why" and ideally a proposed fix or question to resolve it.
   - Cross-check with Assumption Coverage table: every `unverified` row must have a corresponding finding.

7. **Determine verdict:**
   - **`approve`**: Zero blocking findings. Spec is ready for implementation.
   - **`needs-work`**: One or more blocking findings. Spec needs updates before claiming.

8. **Post review comment AND set labels (both are MANDATORY Gitea API calls — do not skip either):**

   **8a. Post the review comment:**
   - Write comment to temp file, then: `gitea issue-comment <id> --body-file <temp-file-path>`
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

9. **Report:** Summary of verdict and key findings.

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
- **Re-reviews require prior comment reading.** On any issue that already has `## Spec Review` comments, step 2 is mandatory. Skipping it produces review loops where the same finding bounces back and forth.
- **Stand your ground when you're right.** If the author disputes a finding and their rationale is wrong, rebut it with specific evidence. Don't withdraw just because they pushed back — withdraw because they proved you wrong. But if they DID prove you wrong, have the intellectual honesty to drop it.
