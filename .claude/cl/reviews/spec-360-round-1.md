---
skill: respond-to-spec-review
issue: 360
round: 1
date: 2026-03-14
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: AC4 invented a new API signature for SettingsService.update()
**What was caught:** The AC specified `update(category, partial)` but the actual method is `update(partial: Partial<AppSettings>)`. Changing the signature would force route, schema, and test contract changes the spec never mentioned.
**Why I missed it:** Wrote the AC describing desired behavior without reading the actual function signature and its callers. The `/elaborate` subagent reported the deep-merge gap but didn't verify the exact method signature.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "For any AC that changes a function's behavior, read the full function signature AND all callers (routes, tests) to verify the AC preserves or explicitly accounts for the existing API contract."

### F2: AC7 magic number list was stale and unbounded
**What was caught:** `86400000` only exists in tests/client, not production backend. `60_000` appears in many unrelated modules, making AC7 ambiguous.
**Why I missed it:** Trusted the debt scan findings list without grepping each literal to verify its actual production-code locations. The `/elaborate` subagent was told to "find all occurrences" but the AC was written from the findings document rather than from grep results.
**Prompt fix:** Add to `/elaborate` step 4 (gap-fill): "For dedup/cleanup specs, every literal or pattern named in an AC must have a verified file:line punch list from grep. Do not write ACs that say 'named constants in relevant modules' — list the exact files."

### F3: AC8 only covered 2 of 4 registries
**What was caught:** `import-list-registry.ts` and `notifier-registry.ts` have the same `RequiredField` + metadata pattern.
**Why I missed it:** The finding said "duplicated 4 times" but I only verified two files. The subagent was asked to check but its glob only returned 2 matches.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "When a finding says a pattern is duplicated N times, glob for all files matching the pattern (e.g., `*-registry.ts`) and verify the count matches. If the count differs, note the discrepancy."

### F4: AC1 missed sentinel passthrough in import-list and prowlarr
**What was caught:** Same `isSentinel` passthrough pattern exists in `import-list.service.ts` and `routes/prowlarr.ts`.
**Why I missed it:** Trusted the debt scan finding that named 3 services without grepping `isSentinel` across the full codebase to find all instances.
**Prompt fix:** Same as F2 — for dedup specs, grep the target pattern and enumerate all instances before writing the AC.

### F5: Test plan used nonexistent nested quality schema shape
**What was caught:** "Preserves nested quality profile settings" — but `qualitySettingsSchema` is flat.
**Why I missed it:** Assumed nesting without reading the schema file. Wrote a test scenario based on what deep-merge *could* do rather than what the actual data structures look like.
**Prompt fix:** Add to `/elaborate` step 4 (test plan gap-fill): "When writing test scenarios that reference specific data shapes, read the actual schema/type definition to verify the structure. Do not assume nesting, optionality, or field names."
