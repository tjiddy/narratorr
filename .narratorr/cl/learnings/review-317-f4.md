---
scope: [frontend]
files: [src/client/components/settings/IndexerFields.tsx, src/client/components/settings/IndexerFields.test.tsx]
issue: 317
source: review
date: 2026-04-03
---
When adding async detection UI (blur → API → side effects), the first round of interaction tests covered happy/error paths but missed three independently breakable behaviors: payload construction (baseUrl passthrough), timing (overlay minimum duration), and side effects (isVip written to form state). Each of these is a distinct code path that can regress independently. The pattern: for any async UI flow, test the request payload, the loading UX, and every state mutation — not just the final rendered outcome.
