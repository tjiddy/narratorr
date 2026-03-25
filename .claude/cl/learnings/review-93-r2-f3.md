---
name: review-93-r2-f3
description: placeholderData fix in useLibrary also needed a corresponding test proving previous-page data stability
scope: [scope/frontend]
files: [src/client/hooks/useLibrary.ts, src/client/hooks/useLibrary.test.tsx]
issue: 93
source: review
date: 2026-03-25
---
Same root cause as review-93-r2-f2: the blast-radius fix to `useLibrary.ts` added `placeholderData: (prev) => prev` without a corresponding test covering the stability contract. The fix was applied mechanically as part of a sibling pattern sweep, but no test was written to verify the option actually prevents `data=undefined` flicker when params change.

**Why missed:** Sibling pattern check found the file but did not produce a test requirement for each file found.

**What would have prevented it:** See review-93-r2-f2. Every `placeholderData` addition (and other behavior-changing query options) needs a `renderHook` + `rerender` + pending-promise test asserting the previous data is still visible synchronously after the key change.
