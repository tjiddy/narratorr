---
skill: respond-to-pr-review
issue: 21
pr: 25
round: 1
date: 2026-03-20
fixed_findings: [F1, F2, F3, F4]
---

### F1: Production wiring in index.ts untested
**What was caught:** Test apps built bespoke Fastify instances with manual plugin registration — they passed even if `index.ts:62` removed `cspNonceStripPlugin`.
**Why I missed it:** During implementation, the focus was on the hook behavior (does the regex work?), not on the architectural coupling between the production wiring and the test helpers. I added the plugin to `createApp()` in the test files by copying the `index.ts` pattern, but didn't notice this created a divergence risk.
**Prompt fix:** Add to `/implement` step 4d (blast radius check): "For new plugins registered in `index.ts`, check whether existing test helpers (e.g., `createAppWithHelmet` in server-utils.test.ts) also register related plugins. If tests build apps manually, extract a shared registration helper and use it in both production and tests."

### F2: Real HTML nonce-injection path not tested with strip plugin
**What was caught:** `server-utils.test.ts` `createAppWithHelmet` didn't include `cspNonceStripPlugin`, so the HTML nonce roundtrip test was testing the behavior WITHOUT the strip plugin active.
**Why I missed it:** When adding a plugin that modifies response headers, I updated the test helpers in the new plugin's own test file and in `helmet.test.ts`, but didn't check whether `server-utils.test.ts` (which has a separate `createAppWithHelmet` helper) also needed updating. Didn't enumerate ALL test helpers that build apps with the affected plugins.
**Prompt fix:** Add to `/implement` step 4d: "When adding a plugin that modifies security headers or cross-cutting response behavior, grep `*.test.ts` for all `createApp` / helper functions that register related plugins (e.g., helmet). Update every one of them to include the new plugin, and add assertions for the combined behavior."

### F3: Manual verification AC left unchecked without explanation
**What was caught:** The PR body left the browser-console verification checkbox unchecked without explaining why.
**Why I missed it:** Treated the checkbox as a reminder for a future human step, but didn't add a note explaining this is pending manual sign-off.
**Prompt fix:** Add to `/handoff` PR body template: "For any AC marked '(manual verification)', either check it with a verification artifact or add an explicit note: 'Pending manual verification — requires [description].'"

### F4: SECURITY.md eval() attribution too specific
**What was caught:** Attributed the eval() violation to specific third-party libraries (Vite, TanStack Query) without actual bundle evidence.
**Why I missed it:** Used the list of candidates from the elaborate/spec phases as if they were confirmed sources, rather than labeling them as unconfirmed suspects.
**Prompt fix:** Add to `/implement` step for documentation changes: "When documenting investigation results, distinguish between what was directly observed (grep result, test output) and what is inferred (suspected source). Use hedging language ('likely', 'requires further investigation') for the latter."
