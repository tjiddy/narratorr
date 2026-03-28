---
skill: respond-to-spec-review
issue: 365
round: 1
date: 2026-03-15
fixed_findings: [F1, F2, F3, F4, F5, F7]
---

### F1: L-4 blacklist.reason only addressed DB layer
**What was caught:** Making `blacklist.reason` NOT NULL without updating the Zod schema, API client, or defining a backfill policy would cause runtime failures on manual creates.
**Why I missed it:** `/elaborate` checked service call sites (all provide reason) but didn't trace the public input contract — `createBlacklistSchema` and `blacklistApi.addToBlacklist()` both allow omitting reason.
**Prompt fix:** Add to `/elaborate` step 10 (deep source analysis): "For DB constraint changes (NOT NULL, new FK, type narrowing), trace the full write path: UI form → API client → Zod input schema → route handler → service → DB. If any upstream layer allows the value being constrained, the spec must define the contract change at every layer."

### F2: M-17 downloadClientId cascade mischaracterized
**What was caught:** `onDelete: 'set null'` is intentional — 4 service/job sites handle null `downloadClientId` for in-flight downloads. "Zombie records" label was wrong.
**Why I missed it:** `/elaborate` trusted the debt scan's characterization without reading the downstream code that handles the null case. The subagent was asked to check schema but not to verify whether null-FK handling was intentional.
**Prompt fix:** Add to `/elaborate` step 10: "For FK cascade/constraint changes, read all callers that query the affected column (especially null/guard checks). If multiple callers defensively handle null, the nullable behavior is likely intentional — flag the finding as 'needs verification' rather than accepting it as actionable."

### F3: L-35 AuthProvider redirect not dead
**What was caught:** The redirect is active and tested — `AuthProvider.tsx:20-21` and `AuthProvider.test.tsx:45-54`.
**Why I missed it:** `/elaborate` trusted the "dead code" label from the debt scan without reading the source or test file.
**Prompt fix:** Add to `/elaborate` step 3 (Explore subagent): "For any finding labeled 'dead code' or 'unused', the subagent MUST read both the source file and its co-located test file to verify the claim. Dead code assertions require evidence, not trust."

### F4: L-13 mapDownloadStatus targets wrong layer
**What was caught:** `DownloadItemInfo.status` is a closed union; the default branch is unreachable under the type contract.
**Why I missed it:** `/elaborate` accepted the "unreachable default branch" finding without checking the input type. The type system already prevents the scenario the finding describes.
**Prompt fix:** Add to `/elaborate` step 10: "For switch/map default branch findings, check the input type. If the input is a closed union with no string/number escape hatch, the default is unreachable and the finding should be retargeted or dropped."

### F5: L-14 test plan wrong endpoint
**What was caught:** Test plan targeted `/api/health` (status/timestamp only) instead of `/api/system/info` (where version lives).
**Why I missed it:** Assumed the health route file serves `/api/health`, but `health-routes.ts` serves `/api/system/info` while `system.ts` serves `/api/health`.
**Prompt fix:** Add to `/elaborate` test plan gap-fill: "When test cases assert HTTP endpoint behavior, the subagent must read the route file to confirm the actual URL path served. Do not infer endpoints from file names."

### F7: Source artifact doesn't exist
**What was caught:** `debt-scan-findings.md` is not tracked in the repo.
**Why I missed it:** Preserved the original issue's source reference without verifying the file exists.
**Prompt fix:** Add to `/elaborate` step 6 (verify fixes): "Verify all artifact references (source files, docs, scripts) exist in the repo with `git ls-files` before including them in the spec."
