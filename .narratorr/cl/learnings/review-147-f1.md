---
scope: [scope/frontend]
files: [src/client/components/library/BulkOperationsSection.tsx, src/client/components/library/BulkOperationsSection.test.tsx]
issue: 147
source: review
date: 2026-03-27
---
The reviewer caught that the new non-Error fallback branch in `handleOperationClick()` had no component test. The existing tests only covered `Error` rejections, which would pass even if the fallback string regressed to an unsafe cast.

Why we missed it: The implementation focused on Error-case coverage per existing patterns. The non-Error fallback is new behavior introduced by the TS-1 narrowing change, but the test plan only listed non-Error tests for providers and useBulkOperation explicitly — not for every narrowing-fix site.

What would have prevented it: When fixing an unsafe cast with a ternary fallback (instanceof Error ? error.message : 'fallback string'), always add a test for BOTH branches. The non-Error branch is genuinely new behavior. Add this rule to the implementation checklist for TS-1-style narrowing fixes.
