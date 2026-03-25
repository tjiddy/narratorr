---
skill: respond-to-pr-review
issue: 82
pr: 90
round: 1
date: 2026-03-25
fixed_findings: [F1, F2, F3]
---

### F1: LocalBypassSection toggle — missing post-refetch checkbox state assertion
**What was caught:** Tests stopped at `updateAuthConfig` call and toast assertions. The AC explicitly required "reflects new state" but the checkbox UI state after the mutation-driven refetch was never checked.
**Why I missed it:** I interpreted "fires mutation" as the full AC. The "reflects new state" clause was treated as a bonus, not a hard requirement. When a mutation invalidates queries, the UI that subscribes to those queries is what changes — and that's the thing worth asserting.
**Prompt fix:** Add to `/implement` test-writing checklist: "For mutations that call `invalidateQueries`, assert the UI state that depends on the refetched query after the mutation completes — not just the mutation payload."

### F2: updateLocalBypass — isEncrypted() not sufficient for secret preservation
**What was caught:** `isEncrypted(stored.apiKey)` doesn't prove the value is unchanged — only that something was encrypted. A regeneration bug passes this check.
**Why I missed it:** I conflated "encryption proves identity" with "encryption proves format". Since `setAuthConfig` always re-encrypts, any value will be encrypted whether it was preserved or generated fresh.
**Prompt fix:** Add to CLAUDE.md Gotchas: "isEncrypted() proves format, not identity. To test secret preservation through encrypt/decrypt round-trip, use `decryptFields()` and assert the decrypted value equals the original input."

### F3: timingSafeEqual — invocation check insufficient, needs argument + success path
**What was caught:** `toHaveBeenCalled()` proves the spy ran but not what buffers it received. Only the wrong-password path was tested; the success path (where buffers match and result is truthy) was missing.
**Why I missed it:** I focused on the "timing-safe = not short-circuited" behavior and forgot the equally important "correct buffers" contract. Also wrote only one path when the spec test plan named both.
**Prompt fix:** Add to `/implement` spy-assertion checklist: "For security-critical function spies (timingSafeEqual, crypto primitives), always use `.toHaveBeenCalledWith()` with argument matchers. Cover both truthy and falsy outcome paths — `toHaveBeenCalled()` alone proves nothing."
