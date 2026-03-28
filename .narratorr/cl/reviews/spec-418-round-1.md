---
skill: respond-to-spec-review
issue: 418
round: 1
date: 2026-03-17
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: File count mismatch (8 claimed, 6 listed)
**What was caught:** AC3 references "all 8 locations above" but the spec only enumerates 6 files.
**Why I missed it:** Wrote the count first, then the bullet list, and never reconciled. The count was based on a mental tally that included settings files, but I forgot to add them as bullets.
**Prompt fix:** Add to `/spec` AC checklist: "If any AC references a count of artifacts, verify the count matches the enumerated list in the spec body."

### F2: Discovery settings files omitted from scope
**What was caught:** `src/shared/schemas/settings/discovery.ts` and `registry.ts` hardcode the same reason keys but were left out of scope.
**Why I missed it:** I searched for the `SuggestionReason` type name and the literal union syntax, but the settings files express the same duplication as Zod object property names — a different surface pattern.
**Prompt fix:** Add to `/spec` codebase exploration step: "When auditing enum/union fan-out, search for each individual value string (e.g., grep for `'author'` across all `*.ts` files), not just the type name or full union pattern."

### F3: Headline goal overpromises vs scope boundaries
**What was caught:** "The next reason can be added in one place" contradicts the out-of-scope section which leaves service-layer switch/weight logic untouched.
**Why I missed it:** The motivating sentence was aspirational — describing the ideal end state rather than what this specific refactor delivers. I didn't cross-check the goal statement against out-of-scope items.
**Prompt fix:** Add to `/spec` final validation: "Re-read the issue description's goal statement and verify it is achievable within the stated scope boundaries. If out-of-scope items prevent the stated goal, narrow the goal language."

### F4: Client reason surfaces incompletely covered in AC
**What was caught:** AC7/AC8 covered `FILTER_OPTIONS` and `SuggestionRow.reason` but missed `DiscoverStats` keys and `ReasonFilter` type.
**Why I missed it:** I listed one artifact per file rather than auditing all exports that reference the enum values.
**Prompt fix:** Add to `/spec` AC writing step: "For each affected file, audit ALL exported symbols that reference the target enum/type — don't stop at the most obvious one per file."

### F5: Blast-radius list stale
**What was caught:** Listed `activity.test.ts` (unrelated) and missed `discover.test.ts` and `discovery.test.ts` (relevant).
**Why I missed it:** Inferred test impact from file names and proximity rather than grepping for actual usage.
**Prompt fix:** Add to `/spec` blast-radius step: "Build the test blast-radius list by grepping test files for the specific string literals being refactored, not by guessing from file names."