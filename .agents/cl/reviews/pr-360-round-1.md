---
skill: respond-to-pr-review
issue: 360
pr: 377
round: 1
date: 2026-03-14
fixed_findings: [F1, F2, F3, F4, F5, F6, F7]
---

### F1-F3: Missing sentinel preservation tests in service update methods
**What was caught:** The shared `resolveSentinelFields` extraction had no direct tests proving that service `update()` methods preserve encrypted values when sentinels are submitted.
**Why I missed it:** The self-review only checked that existing tests still passed after the extraction. The TDD cycle tested `resolveSentinelFields` in isolation (secret-codec.test.ts) but didn't add integration tests proving the services correctly wire the helper to their `.set()` persistence calls.
**Prompt fix:** Add to `/implement` phase 3 step 4d (blast radius check): "When extracting a shared helper from N callsites, verify each callsite has a test that asserts the helper's effect on the persisted data — not just that the operation succeeds. Testing the helper in isolation is necessary but not sufficient."

### F4-F7: SSE debug-log branches unproven by existing tests
**What was caught:** Changing `catch { }` to `catch (e) { log.debug(e, 'msg') }` — existing "does not throw" tests pass whether or not the logging actually runs.
**Why I missed it:** Treated the catch block changes as trivial one-liners that were covered by existing "does not break" tests. But a survival test (`resolves.not.toThrow()`) is not the same as an observability test (`log.debug` was called with the error).
**Prompt fix:** Add to `/implement` testing standards or `/handoff` self-review step 2: "When adding logging to catch blocks, verify the test asserts the log method is called with the specific error and message — not just that the parent operation doesn't throw."
