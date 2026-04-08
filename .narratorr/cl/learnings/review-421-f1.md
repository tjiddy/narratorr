---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.test.tsx]
issue: 421
source: review
date: 2026-04-08
---
When threading multiple new props from parent to child (lastGrabGuid AND lastGrabInfoHash), modal-level wiring tests must cover both paths independently. The guid-only modal test didn't prove the infoHash prop was wired correctly — if the infoHash line were deleted, all existing modal tests would still pass. When adding N new props in the same change, write at least one modal-level test per prop to prevent silent wiring regressions.
