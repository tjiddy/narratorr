---
skill: respond-to-pr-review
issue: 406
pr: 419
round: 2
date: 2026-03-17
fixed_findings: [F4]
---

### F4: Route test didn't prove runExclusive callback wiring
**What was caught:** The route test asserted `expect.any(Function)` for the callback arg to `runExclusive`, but the mock returned a canned value without ever executing the callback — so the test couldn't detect if the route passed the wrong function.
**Why I missed it:** When I fixed F1 in round 1 by switching from `runTask` to `runExclusive`, I focused on proving the payload contract was restored and that the concurrency guard was invoked. I treated the callback as an implementation detail rather than a testable contract boundary. The round 1 F1 fix was about the *return value* shape, and I didn't re-evaluate whether the *input* (the callback) also needed assertion.
**Prompt fix:** Add to `/respond-to-pr-review` step 3 fix-completeness guidance or to testing.md: "When a fix introduces a higher-order function call (passing a callback/closure to another function), the test must prove the callback's identity — either by executing it via `mockImplementation` and asserting the inner call, or by capturing and inspecting it. `expect.any(Function)` is never sufficient for callback wiring."
