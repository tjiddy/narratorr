---
skill: respond-to-pr-review
issue: 227
pr: 241
round: 1
date: 2026-03-31
fixed_findings: [F1, F2, F3]
---

### F1: mapNetworkError only handles AbortError, not TimeoutError
**What was caught:** `AbortSignal.timeout()` throws `TimeoutError` DOMException, not `AbortError`. The mapper missed the real timeout path.
**Why I missed it:** Test mocked `AbortError` (manual abort) instead of `TimeoutError` (signal timeout). Didn't verify the exact DOMException name thrown by `AbortSignal.timeout()`.
**Prompt fix:** Add to `/implement` step 4a (Red phase): "When testing DOMException handling, verify the exact `.name` property thrown by the specific API (e.g., `AbortSignal.timeout()` throws `TimeoutError`, not `AbortError`). Mock the real name, not a generic one."

### F2: fetchDirect mapping branch not tested at adapter level
**What was caught:** Integration of mapNetworkError into fetchDirect had no tests asserting actionable messages.
**Why I missed it:** Unit tests for mapNetworkError passed, and existing MSW-based tests passed. Assumed unit coverage was sufficient without verifying the wiring.
**Prompt fix:** Add to `/implement` step 4d (Sibling enumeration): "When integrating a shared utility into multiple call sites, add integration tests at EACH call site — not just unit tests for the utility. Each integration point needs a test that asserts the end-to-end behavior through that specific call path."

### F3: no-proxy fetchWithProxyAgent path not tested
**What was caught:** Same gap as F2 but in proxy.ts — the no-proxy error mapping branch had no direct test coverage.
**Why I missed it:** Same root cause as F2 — relied on unit test coverage of the shared utility without testing each integration point.
**Prompt fix:** Same as F2 — the sibling enumeration step should catch this.
