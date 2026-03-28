---
skill: respond-to-spec-review
issue: 423
round: 2
date: 2026-03-17
fixed_findings: [F1, F2, F3]
---

### F1: Direct static entry routes omitted from AC/test plan
**What was caught:** AC1/AC2 only covered SPA fallback injection, missing `/<urlBase>/`, `/<urlBase>/index.html`, and `/` which are served by `@fastify/static` and bypass the not-found handler entirely.
**Why I missed it:** Assumed all HTML responses flowed through the SPA fallback injection path. Didn't trace the `@fastify/static` registration to realize it serves `index.html` directly for directory/file requests before the not-found handler fires.
**Prompt fix:** Add to `/spec` completeness checklist: "For middleware/plugin changes that affect responses, trace ALL code paths that serve the affected content type — static file serving, SPA fallback, and direct routes may each take different paths through the middleware stack."

### F2: Helmet test exercises detached fixture, not real production config
**What was caught:** `helmet.test.ts` hardcodes its own `prodOptions` that had already drifted from the real config in `index.ts`. The test plan could pass without proving the actual app wiring changed.
**Why I missed it:** Took the existing test at face value ("there's a helmet test") without diffing its fixture against the real production config. The spec said "test that CSP changed" but didn't verify the existing test was actually connected to production.
**Prompt fix:** Add to `/elaborate` alignment check: "For any test plan that validates production configuration, verify that the test imports or exercises the actual production config — not a local fixture. If the test hardcodes its own config, flag it as a drift risk and require shared extraction."

### F3: AC3 test assertion already passes before the code change
**What was caught:** `getByRole('checkbox', { name: /enabled/i })` succeeds today via implicit label wrapping, so it wouldn't prove the explicit `htmlFor`/`id` fix.
**Why I missed it:** Didn't mentally execute the proposed test assertion against the current DOM structure. The checkbox is wrapped by `<label>`, which provides an accessible name without explicit `htmlFor`/`id`.
**Prompt fix:** Add to `/spec` test plan checklist: "For each test assertion, verify it would FAIL on the current code and PASS after the change. If it already passes today, it's not testing the intended fix — find a more specific assertion."