---
skill: respond-to-spec-review
issue: 429
round: 4
date: 2026-03-17
fixed_findings: [F1]
---

### F1: Circular-dependency note contradicts actual adapter-type import model
**What was caught:** The note claimed "schemas do NOT import from registries at runtime for adapter types" but `indexer.ts:2`, `download-client.ts:2`, `import-list.ts:2`, and `notifier.ts:2` all import their registries at runtime.
**Why I missed it:** The round 2 fix focused on the notification-event cycle and extrapolated the `downloadStatusSchema` pattern (standalone schema, no registry import) to all adapter types without checking. The `downloadStatusSchema` is actually the exception — it has no registry import because it doesn't do `superRefine` validation.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 verification: "When writing or updating architectural import rules in the spec, grep the actual import statements of ALL files in the affected category (not just one exemplar) to verify the rule matches reality: `grep '^import' src/shared/schemas/<pattern>.ts`"
