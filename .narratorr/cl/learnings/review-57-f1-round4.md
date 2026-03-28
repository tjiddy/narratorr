---
name: review-57-f1-round4
description: 409 retry confirmation path dropped indexerId from PendingGrabParams
scope: [scope/frontend, scope/ui]
files: [src/client/components/SearchReleasesModal.tsx]
issue: 57
source: review
date: 2026-03-24
---

When a grab fails with a 409 ACTIVE_DOWNLOAD_EXISTS, the error handler stores grab params in `PendingGrabParams` for a retry. The interface did not include `indexerId`, so it was dropped at the `setPendingReplace()` call site even though the initial `handleGrab()` had forwarded it correctly.

**Why:** The interface was added for the confirmation-retry flow without mirroring all fields of the original grab payload. The initial grab path was correct but the intermediate storage type was incomplete.

**How to apply:** When implementing an error-retry or confirmation flow, verify that all fields from the original call are preserved in any intermediate state object. The intermediate type must mirror the full payload, not a subset.
