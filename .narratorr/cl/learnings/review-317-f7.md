---
scope: [frontend]
files: [src/client/components/settings/IndexerFields.test.tsx]
issue: 317
source: review
date: 2026-04-03
---
When testing minimum-duration guarantees, the assertion boundary must be close to the threshold (e.g., 900ms for a 1000ms minimum) to distinguish the intended value from any shorter regression. A 200ms check passes for ANY delay >200ms and doesn't prove the 1-second contract. Use the tightest real-time assertion that's still reliable (~90% of the threshold), then assert disappearance shortly after.
