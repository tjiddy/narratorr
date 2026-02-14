# Workflow Skill Enhancements — Planned

Captured 2026-02-14 after running `/implement` on #58, #60, #61 (Usenet pipeline).

---

## 1. Fixes to Current Skills (from running /implement x3)

### 1a. Remove dead `status/ready` check in `/claim` Phase 2 step 8
- Phase 1 (elaborate gate) already validates spec completeness and blocks if not ready
- Step 8 checks for `status/ready` label, but all three issues were `status/backlog` — overridden every time because user explicitly requested work
- **Fix:** Remove step 8. If Phase 1 passes, auto-promote `status/backlog` → `status/ready` before claiming. Phase 1 IS the readiness gate.

### 1b. Structured readiness verdict from elaborate
- Currently elaborate narrates every step in freeform prose, burning main context tokens
- **Fix:** Define a structured output format:
  ```
  VERDICT: ready | filled | not-ready
  AC: present | filled | missing
  Test Plan: present | filled | missing
  Implementation Detail: present | filled | missing
  Dependencies: none | met | unmet (<list>)
  Overlap: none | <PR links>
  Gaps Filled: <list of what was added to issue body>
  Codebase Findings: <compact summary of patterns, interfaces, wiring points>
  ```

### 1c. Skip redundant agent_workflow.md read
- `/claim` step 13 reads `docs/agent_workflow.md` (360 lines) on every claim
- **Fix:** Add "read if not already read this session" instruction, or remove the step entirely — the skill itself encodes the workflow

### 1d. Separate issue enrichment from implementation context
- Elaborate currently dumps codebase paths into the issue body (which go stale)
- **Fix:** Two outputs from elaborate:
  - **Durable:** Issue body enrichment (AC, test plan, scope) — written to Gitea
  - **Ephemeral:** Implementation context (file paths, interfaces, patterns) — kept in memory or temp file, not persisted to issue

### 1e. `/elaborate` standalone smoke test
- Never tested `/elaborate` standalone — only ran via `/claim`
- **Fix:** Test on an issue to verify it doesn't mutate labels/branches

---

## 2. Token Efficiency — Subagent Architecture

### 2a. Quality gates via Bash subagent (`/verify`)
**Problem:** Every `pnpm lint && pnpm test && pnpm typecheck && pnpm build` dumps hundreds of lines into main context. Currently hacked with `| tail -20`.
**Solution:** New `/verify` skill that runs as a Bash subagent:
- Runs all four gates
- Parses output, returns structured summary:
  ```
  LINT: pass (4 errors pre-existing, 0 new) | fail (<new errors>)
  TEST: pass (217 passed, 0 failed) | fail (<failed test names + snippets>)
  TYPECHECK: pass | fail (<errors>)
  BUILD: pass | fail (<errors>)
  ```
- Main context gets ~5 lines instead of ~200
- Used by `/implement` before handoff, by `/handoff` as verification, or standalone

### 2b. Codebase exploration via Explore subagent (already partial)
**Problem:** Explore subagents are used inconsistently. On #61 skipped entirely because "remembered" from #60. Works in single session, fails across sessions.
**Solution:**
- Elaborate ALWAYS uses an Explore subagent for codebase context
- Subagent produces a compact context summary (interfaces, patterns, wiring points, test conventions)
- Summary cached to `.claude/project-context.md` (updated after each handoff)
- Future elaborates read cached context first, only explore for gaps
- Main context never sees raw source files during elaborate — only the summary

### 2c. Issue enrichment via General-purpose subagent
**Problem:** Elaborate phase reads issue, parses completeness, explores codebase, writes enriched body — all in main context.
**Solution:** Entire elaborate logic runs as a subagent:
- Input: issue ID
- Subagent: reads issue, parses spec, explores codebase, fills gaps, updates issue body
- Output to main context: readiness verdict (structured per 1b) + compact codebase findings
- Main agent only makes the gate decision (proceed/block)

### 2d. Diff review via Explore subagent
**Problem:** No self-review before handoff. Code goes straight to PR.
**Solution:** Pre-handoff review subagent:
- Input: branch diff + issue AC
- Subagent reads the diff, checks each AC criterion, looks for common issues
- Output: pass/fail per AC item + any concerns found
- Integrated into `/implement` between quality gates and `/handoff`

### 2e. PR body/comment generation via subagent
**Problem:** Writing temp files with markdown PR bodies is clunky and burns main context on formatting.
**Solution:** Haiku subagent that takes structured data (changes, AC, test results) and produces PR body + comments. Main agent provides the data, subagent handles formatting.

### Where NOT to use subagents
- Actual code implementation — needs full context
- Git operations (commit, branch, push) — cheap, need error handling in main
- Gitea API calls — cheap, sequential, need coordination
- Gate decisions (proceed/block) — main agent's job

---

## 3. New Skills

### 3a. `/verify` — Quality gate runner
**Type:** Bash subagent
**Invocation:** `/verify` (no args — runs in current directory)
**What it does:**
1. Runs `pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm build`
2. Parses each output for pass/fail
3. Extracts failure details (only failures, not passing tests)
4. Returns structured summary to main context
**Used by:** `/implement` (step 4), `/handoff` (step 2), standalone after manual changes

### 3b. `/review <pr-number>` — PR review against AC
**Type:** Explore subagent
**Invocation:** `/review 94` or `/review <pr-number>`
**What it does:**
1. Fetch PR diff via `gh` or `pnpm gitea`
2. Read the linked issue (from `Refs #<id>` in PR body)
3. Check each AC criterion against the diff — is it addressed?
4. Check for common issues (missing tests, missing error handling, scope creep)
5. Post review comment on PR (or report to user)
**Used by:** `/implement` (pre-handoff self-review), standalone from Cursor for code review

### 3c. `/resume <id>` — Resume a blocked issue
**Type:** Main context skill (needs implementation ability)
**Invocation:** `/resume 42`
**What it does:**
1. Read issue, find most recent BLOCKED comment
2. Read only comments after the BLOCKED comment (token-efficient)
3. Extract answers to blocked questions
4. Check out existing feature branch (don't create new)
5. Continue implementation from where it stopped
6. If answers don't resolve block → post new BLOCKED comment, stop
**Why:** Currently resuming is manual and re-reads entire context. This skill finds exactly where you left off.

### 3d. `/triage` — Backlog scanner and prioritizer
**Type:** General-purpose subagent
**Invocation:** `/triage` (no args) or `/triage v0.4` (filter by milestone)
**What it does:**
1. `pnpm gitea issues` — get all open issues
2. For each `status/ready` or `status/backlog` issue:
   - Parse spec completeness (AC, test plan, deps)
   - Check dependency status
   - Check for overlapping in-progress work
3. Rank by: readiness (ready > backlog) → priority label → dependency chain
4. Report to user: "Here's what's ready to claim, here's what needs grooming, here's what's blocked on deps"
**Used by:** Session start ("what should I work on?"), sprint planning from Cursor

### 3e. `/changelog [since]` — Generate release notes
**Type:** Explore subagent
**Invocation:** `/changelog v0.3` or `/changelog 2026-02-01`
**What it does:**
1. `git log --oneline <since>..HEAD` — get merged commits
2. Group by issue number (from `#<id>` prefix)
3. For each issue: read title, categorize (feature/bug/chore)
4. Generate markdown changelog grouped by category
**Used by:** Release prep, weekly updates

### 3f. Project context cache (not a skill, but infrastructure)
**File:** `.claude/project-context.md`
**What it contains:**
- Adapter interfaces (indexer, download client, metadata) — signatures only
- Service patterns (constructor, wiring, caching)
- Test patterns per layer (MSW, inject, render, renderHook)
- DB schema summary (tables, key columns, enums)
- Shared schema summary (Zod schemas, form validation)
- Wiring points (routes/index.ts, services/, App.tsx, Layout.tsx)
- Recent changes (last 5 PRs — what was added/changed)
**Updated by:** `/handoff` appends "what changed" section. Periodic full refresh via `/elaborate` on no specific issue.
**Read by:** Every `/claim` and `/elaborate` — replaces full codebase exploration for known patterns.

---

## Implementation Priority

| Priority | Item | Effort | Token savings |
|----------|------|--------|---------------|
| 1 | `/verify` (subagent quality gates) | Small | High — every implement/handoff |
| 2 | Project context cache | Medium | High — every claim/elaborate |
| 3 | Fixes 1a-1d (current skill cleanup) | Small | Medium |
| 4 | `/review` (diff review) | Medium | Medium + quality improvement |
| 5 | Elaborate as subagent (2c) | Medium | High — keeps main context clean |
| 6 | `/triage` | Small | Low (convenience) |
| 7 | `/resume` | Medium | Medium (blocked issue recovery) |
| 8 | `/changelog` | Small | Low (convenience) |

---

## Revised `/implement` Flow (after all enhancements)

```
/implement <id>
  ├─ [Subagent] elaborate → readiness verdict + context summary
  │    ├─ reads .claude/project-context.md (cached patterns)
  │    ├─ explores codebase only for gaps
  │    ├─ enriches issue body (durable)
  │    └─ returns: verdict + implementation context (ephemeral)
  ├─ Gate: ready? → proceed / block+stop
  ├─ Claim mechanics (main agent — labels, branch, comment)
  ├─ Implement (main agent — writes code, commits)
  ├─ [Subagent] /verify → structured pass/fail
  │    └─ fix failures, re-verify (max 2 attempts)
  ├─ [Subagent] /review → AC check against diff
  │    └─ flag issues before PR
  ├─ /handoff (main agent — push, PR, labels, comment)
  │    └─ update .claude/project-context.md with what changed
  └─ Report completion
```
