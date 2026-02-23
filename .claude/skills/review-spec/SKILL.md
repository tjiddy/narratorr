---
name: review-spec
description: Review an elaborated spec for gaps, missing test plans, and codebase
  assumption errors. Posts structured findings with approve/needs-work verdict. Use
  when user says "review spec", "check spec", or invokes /review-spec.
argument-hint: <issue-id>
disable-model-invocation: true
---

# /review-spec <id> — Review an issue spec for gaps and quality

Reviews an elaborated issue spec with fresh eyes. Explores the codebase exhaustively to validate assumptions, find gaps, and suggest improvements. Posts structured findings as a comment. Moves to `ready` on approve, stays `backlog` on needs-work.

**This skill must be run by a different agent than the one that wrote the spec.**

**Review policy: high recall.** Prefer false positives over missed defects. The cost of a spec author dismissing a noisy suggestion is far lower than the cost of a missed gap reaching implementation. Do not cap the number of findings — report everything you find. Use `suggestion` liberally for anything that *might* matter; reserve `blocking` strictly for issues that would cause implementation failure, incorrect behavior, or untestable requirements.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

1. **Read the issue:** Run `gitea issue <id>`. Extract:
   - Title, labels, milestone
   - Full issue body (spec)
   - Existing comments (prior review findings, elaboration notes)

1b. **Parse prior review history (re-reviews only):** From the comments extracted in step 1, find all comments containing `## Spec Review` (prior reviews) and `## Spec Review Response` (author responses). Build a map of prior findings and their resolutions:
   - For each prior finding ID (F1, F2, etc.), note: the original finding, the author's resolution (`fixed`, `accepted`, `disputed`), and any rationale provided.
   - If this is the first review (no prior `## Spec Review` comments), skip to step 2.
   - **This does NOT reduce the scope of the review.** Steps 2-4 still run in full — you may find net-new issues that prior rounds missed. The prior history only affects how you handle findings that overlap with previously-disputed items (see dispute engagement rules below).

   **Dispute engagement rules** — these apply in step 5 when classifying findings. After completing the full review (steps 2-4), check each finding against the prior history map:
   - If a finding was previously raised and the author **fixed** it (updated the spec), verify the update addresses the issue. If it does, drop the finding. If the fix is incomplete, raise a NEW finding explaining what's still wrong.
   - If a finding overlaps with something the author previously **disputed** with rationale, you MUST engage with their specific argument before re-raising it:
     1. **Withdraw** — the author's rationale is correct. Drop the finding.
     2. **Rebut** — the author's rationale is wrong. Raise the finding with a NEW reason that directly refutes their argument.
     3. **Refine** — the author's rationale is partially correct. Raise a narrower finding that accounts for their point.
   - **Re-raising a finding with the same description and reason after it was disputed is NOT allowed.** If you can't rebut the author's specific argument, withdraw. Repeating yourself is not reviewing.
   - If a finding was previously **accepted** or **deferred**, it's resolved — don't re-raise.
   - **Net-new findings are always welcome** regardless of prior history.

2. **Read project context:**
   - Read `CLAUDE.md` for design principles, testing standards, project philosophy, and architecture patterns
3. **Explore the codebase** — Do a thorough exploration relevant to the issue scope. This is not a token-saving step — be exhaustive:
   - Find existing code that the spec will touch or extend
   - Understand current patterns, interfaces, and data flow in the affected areas
   - Identify existing tests in the area to understand coverage patterns
   - Check for related features that might interact or conflict
   - Look for prior art — has something similar been built elsewhere in the codebase?

4. **Evaluate the spec** against these checklists:

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

   **Design checks (from CLAUDE.md principles):**
   - SRP: Does the plan keep single responsibility per file? Or does it add a second concern to existing files?
   - DRY: Does the plan duplicate a pattern that already exists? Should it reuse or extract a shared component/hook/service?
   - Open/Closed: Does wiring the feature require modifying 4+ existing files? Should there be a registry/plugin pattern instead?
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

5. **Classify findings** — For every issue found, create a finding with severity. Do not cap the number of findings — report everything you find.
   - **`"blocking"`**: Spec cannot be implemented correctly without addressing this. Missing AC, contradictions, wrong assumptions about existing code, untestable requirements. Blocking findings must be evidence-based — point to a specific spec line and a specific codebase fact that conflicts, or a concrete scenario that the spec fails to handle.
   - **`"suggestion"`**: Would improve the spec but not strictly required. Use liberally across these categories: edge case coverage, alternative approaches, pattern improvements, test-quality gaps, maintainability concerns, observability/logging gaps, naming clarity, and future regression risk.
   - Every finding MUST include a concrete "why" and ideally a proposed fix or question to resolve it.

6. **Determine verdict:**
   - **`approve`**: Zero blocking findings. Spec is ready for implementation.
   - **`needs-work`**: One or more blocking findings. Spec needs updates before claiming.

7. **Post review comment on issue:**
   - Write comment to temp file, then: `gitea issue-comment <id> --body-file <temp-file-path>`
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

8. **Update labels based on verdict:**

   **If `approve`:**
   - Replace `status/backlog` with `status/ready` in the label set (keep all other labels)
   - Run: `gitea issue-update <id> labels "<comma-separated>"`

   **If `needs-work`:**
   - Labels stay as-is (`status/backlog`)
   - The spec author (human or elaborate agent) reads the findings, updates the spec, and leaves a "spec updated" comment
   - Another `/review-spec` run is triggered manually after updates

9. **Report:** Summary of verdict and key findings.

## Important

- This skill is for **reviewing** specs, not writing them. Never modify the issue body — only leave comments.
- Findings should be actionable. "This could be better" is not a finding. "AC item 3 says 'handles errors' but doesn't specify what the user sees when the API returns 500" is a finding.
- The codebase exploration in step 3 is critical — most high-value findings come from discovering that the spec's assumptions don't match reality. Don't skip or shortcut it.
- An `approve` verdict means zero blocking findings. Any blocking finding → `needs-work`.
- Blocking findings require concrete evidence — a specific spec statement that conflicts with a specific codebase fact, or a concrete scenario that would fail. "This might cause issues" is not blocking; "AC 2 assumes `getBook()` returns narrators but it doesn't — see `services/book.ts:45`" is blocking.
- Use suggestions liberally. When in doubt about severity, make it a suggestion — the spec author can promote it if they agree it matters.
- If there are no findings at all, use an empty array: `[]`
- Consult the project's CLAUDE.md philosophy section — optimize findings for defect prevention, not compliance.
- **Re-reviews require prior comment reading.** On any issue that already has `## Spec Review` comments, step 1b is mandatory. Skipping it produces review loops where the same finding bounces back and forth.
- **Stand your ground when you're right.** If the author disputes a finding and their rationale is wrong, rebut it with specific evidence. Don't withdraw just because they pushed back — withdraw because they proved you wrong. But if they DID prove you wrong, have the intellectual honesty to drop it.
