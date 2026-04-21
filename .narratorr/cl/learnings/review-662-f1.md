---
scope: [scope/backend, scope/core]
files: [src/core/download-clients/sabnzbd.test.ts, src/core/download-clients/sabnzbd.ts]
issue: 662
source: review
date: 2026-04-21
---
Reviewer caught that the `getDownload()` limit-preservation refactor had no direct
regression test — the existing tests at `sabnzbd.test.ts:307-447` only asserted
mapped return values, never the request URL. The refactor could have silently
dropped `limit='1000'` or changed it, and every test would still have passed.

Why we missed it: treated "no behavior change" as "no new tests needed". For a
refactor whose entire purpose is preserving a specific wire value, the wire value
itself is the behavior under test — not the mapped result. When the acceptance
criterion is literally "the constant value stays '1000'", there must be an
assertion on the request that proves it.

Prevention: For a refactor labeled as "preserve behavior X", the fix-completeness
check is "would this test fail if X were removed?" — not "does it still pass?".
Run the test, then mentally (or actually) break the behavior and confirm the
test flips red. Applies whenever extracting a literal, renaming a constant, or
deduplicating repeated values through a shared symbol.
