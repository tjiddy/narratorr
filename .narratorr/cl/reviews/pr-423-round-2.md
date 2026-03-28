---
skill: respond-to-pr-review
issue: 423
pr: 425
round: 2
date: 2026-03-17
fixed_findings: [F1, F2]
---

### F1: No assertion that HTML script nonce matches CSP header nonce
**What was caught:** Tests verified nonce presence in the CSP header (helmet.test.ts) and in the HTML body (server-utils.test.ts) independently, but never asserted they were the same value.
**Why I missed it:** Focused on testing each layer's behavior in isolation without considering the cross-boundary integration. The nonce originates in helmet, flows through reply.cspNonce, and lands in the HTML — each hop was tested but the end-to-end equality wasn't.
**Prompt fix:** Add to /plan step for security-related features: "When a value propagates across plugin/middleware/handler boundaries (e.g., nonce from helmet → reply → HTML), include at least one integration test that extracts the value from both the origin (header) and destination (body) and asserts exact equality."

### F2: No test for static asset pass-through after routing config change
**What was caught:** The switch to `index: false` and `wildcard: true` in @fastify/static config could break static asset serving, but no test requested a non-HTML asset to verify it still worked.
**Why I missed it:** Test plan covered only the new behaviors (explicit HTML entry routes, nonce injection) and missed that the config change also affects existing static asset routing. Classic "test the change, not the impact" gap.
**Prompt fix:** Add to /plan test coverage step: "When modifying plugin configuration that affects multiple behaviors, enumerate ALL behaviors affected by the config change — not just the target behavior. Test both changed and preserved behaviors."
