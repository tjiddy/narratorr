---
skill: respond-to-spec-review
issue: 431
round: 2
date: 2026-03-17
fixed_findings: [F10, F11]
---

### F10: fetchWithTimeout scope contradicts implementation
**What was caught:** Transmission listed in scope but its timeout code (rpc) was out of scope; notifiers described as AbortController but actually use AbortSignal.timeout
**Why I missed it:** In round 1 I narrowed the scope without re-verifying what timeout mechanism each adapter actually uses. Assumed all were AbortController without re-grepping.
**Prompt fix:** Add to /respond-to-spec-review step 6: "When narrowing or reshaping a utility's scope, re-grep for the actual mechanism in every listed call site. Verify that no in-scope adapter is simultaneously excluded by a different exclusion clause."

### F11: Fire-and-forget inventory still undercounted
**What was caught:** 5 notification fire-and-forget calls, not 3 — missed import-side-effects.ts:87 and :156
**Why I missed it:** In round 1 I used the Explore subagent's results which found 3 instances, and didn't independently verify the count. The subagent missed import-side-effects because it searched for `Promise.resolve` but these calls don't use that wrapper.
**Prompt fix:** Add to /elaborate Explore subagent prompt: "When counting instances of a pattern, grep for ALL variants of the pattern (e.g., both `Promise.resolve(x).catch()` and `x.catch()` for fire-and-forget). Return the full list with file:line for each instance."
