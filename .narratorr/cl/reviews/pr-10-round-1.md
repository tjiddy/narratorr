---
skill: respond-to-pr-review
issue: 10
pr: 14
round: 1
date: 2026-03-19
fixed_findings: [F1, S1]
---

### F1: Combined base+nonce assertions missing on Helmet path
**What was caught:** The new `<base>` tests used plain Fastify, while Helmet-path tests only asserted nonces. The intersection — Helmet response with both `<base>` and nonce — was never tested. A regression in either path could pass both test suites independently.

**Why I missed it:** The `base href injection` describe block was written as a focused unit covering just the new behavior. The existing nonce tests were not revisited to check whether they should be extended. The "test every layer you changed" principle wasn't applied to the interaction between existing and new rewrites.

**Prompt fix:** Add to `/implement` step 4 (red/green TDD): "For functions that perform multiple sequential rewrites/mutations, write at least one combined-assertion test that verifies all mutations are present in a single response. When adding a new mutation to an existing multi-rewrite function, check whether existing test suites for the other mutations need a new intersection test."

### S1: /index.html entry routes not covered by new base assertions
**What was caught:** The new `<base>` assertion tests covered `/`, deep SPA routes, prefixed `/`, and prefixed deep routes — but not the explicit `/index.html` and `/<urlBase>/index.html` entry routes, which also call `sendIndexHtml()`.

**Why I missed it:** When writing test cases for a fix, I focused on the canonical paths (root and deep SPA) and didn't enumerate all call sites of the changed function. `sendIndexHtml()` is called from both the SPA fallback handler and the explicit entry route handlers — the latter were exercised by existing tests for different assertions but not the new assertion.

**Prompt fix:** Add to `/implement` step 4: "When adding assertions to an existing function, grep for all call sites of that function and verify the test matrix includes the new assertion for each distinct call site."
