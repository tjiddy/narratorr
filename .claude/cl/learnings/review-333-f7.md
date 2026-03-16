---
scope: [frontend]
files: [src/client/components/layout/UpdateBanner.test.tsx, src/client/components/layout/UpdateBanner.tsx]
issue: 333
source: review
date: 2026-03-10
---
Reviewer caught that the dismiss test only asserted `api.dismissUpdate` was called, but never proved the `onSuccess` handler's `invalidateQueries` removed the banner. Deleting the onSuccess block would leave the suite green. Fixed by mocking `getSystemStatus` to return `dismissed: true` on subsequent calls and asserting the banner disappears. Lesson: mutation tests must assert the full chain — API call AND the UI consequence of the success handler.
