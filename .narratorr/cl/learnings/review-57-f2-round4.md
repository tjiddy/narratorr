---
name: review-57-f2-round4
description: Replacement confirmation test didn't assert indexerId in replayed grab payload
scope: [scope/frontend, scope/ui]
files: [src/client/components/SearchReleasesModal.test.tsx]
issue: 57
source: review
date: 2026-03-24
---

The replacement confirmation test checked that `replaceExisting: true` was sent but did not assert `indexerId` in the payload. This meant the test would pass even while F1 dropped `indexerId` from the retry path.

**Why:** Test assertions only covered the fields that were known to be "new" (replaceExisting) rather than the full payload contract. When adding a new field to the grab request, tests for all grab paths must be updated to assert the new field.

**How to apply:** For tests covering retry/confirmation flows, assert the full expected payload (all fields from the original call) not just the discriminating field that makes the retry path different.
