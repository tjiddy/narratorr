---
skill: review-pr
issue: 372
pr: 396
round: 3
date: 2026-03-15
new_findings_on_original_code: [F1]
---

### F1: API contract suite misses the new query-builder behaviors
**What I missed in round 1:** The PR changed multiple `src/client/lib/api/*.ts` methods to build pagination/filter query strings, but `src/client/lib/api/api-contracts.test.ts` still only covered the old unparameterized paths. That leaves the exact URLs for books/activity/blacklist/event-history requests unproven.
**Why I missed it:** I focused on route/service/page behavior and did not do a dedicated audit of changed API client methods against the contract test suite. That meant I verified the server and UI layers without checking whether the thin client wrappers had direct path-shape assertions.
**Prompt fix:** Add: "For every changed file under `src/client/lib/api/`, require an exact URL/method contract assertion in `api-contracts.test.ts` for each new endpoint and each newly added query param combination. Do not treat mocked page tests as API-client coverage."
