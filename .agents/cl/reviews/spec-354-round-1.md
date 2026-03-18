---
skill: respond-to-spec-review
issue: 354
round: 1
date: 2026-03-14
fixed_findings: [F1, F2, F3, F4]
---

### F1: downloads.externalId index has no consumer
**What was caught:** The spec required an index on `downloads.externalId` but no selective DB query on that column exists — the monitor job uses it in-memory.
**Why I missed it:** `/elaborate` accepted the debt scan finding ("monitor job cross-references by externalId") without tracing the actual query to source code. The subagent noted the tautology bug but didn't flag that removing the bug wouldn't create a new selective query either.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "For each index being added, verify the claimed query workload by finding the actual `eq()`/`inArray()`/`WHERE` usage in source. If the column is only used in-memory or in a known-buggy tautology, flag it as 'no current consumer'."

### F2: Dead source reference
**What was caught:** `debt-scan-findings.md` doesn't exist in the repo.
**Why I missed it:** `/elaborate` preserved the original issue's source reference without checking if the file is tracked.
**Prompt fix:** Add to `/elaborate` step 4 durable content rules: "When preserving source references from the original issue, verify the referenced file exists in the repo (`ls` or `git ls-files`). Replace missing references with inline code evidence."

### F3: Ambiguous migration artifact wording
**What was caught:** "Single migration file" doesn't account for `drizzle/meta` updates.
**Why I missed it:** Used generic wording without checking the repo's actual migration output structure.
**Prompt fix:** Add to `/elaborate` codebase exploration: "For DB schema changes, check what artifacts `pnpm db:generate` actually produces (SQL files + meta files) and use precise language in AC."

### F4: Vague idempotence test
**What was caught:** Test plan didn't specify how to verify migrations are idempotent.
**Why I missed it:** Treated "server starts" as sufficient verification without thinking about what "existing DB" means operationally.
**Prompt fix:** Add to `/elaborate` test plan gap-fill: "For migration AC, include an explicit restart-against-same-DB verification step, not just 'server starts'."
