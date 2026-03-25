---
name: review-93-r2-f4
description: placeholderData fix in BlacklistSettings also needed a component-level test for pending-fetch data stability
scope: [scope/frontend]
files: [src/client/pages/settings/BlacklistSettings.tsx, src/client/pages/settings/BlacklistSettings.test.tsx]
issue: 93
source: review
date: 2026-03-25
---
Same root cause as review-93-r2-f2/f3: the blast-radius fix to `BlacklistSettings.tsx` added `placeholderData` without a test. Because BlacklistSettings uses the option in a component (not a standalone hook), the appropriate test level is a component render test: render with page-1 data, click Next (triggering pending page-2 fetch), assert page-1 items still visible — then resolve page-2 and assert transition.

**Why missed:** Sibling pattern check swept the file, applied the fix, but the "each fix needs a test" rule was not applied to this component-level fix.

**What would have prevented it:** Same rule as f2/f3 — any `placeholderData` addition needs a test. For component-level fixes, the test is a click-then-assert flow with a pending promise rather than a `renderHook` rerender.
