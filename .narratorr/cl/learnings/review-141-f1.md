---
scope: [scope/frontend]
files: [src/client/pages/library-import/useLibraryImport.ts, src/client/pages/library-import/LibraryImportPage.tsx, src/client/pages/library-import/LibraryImportPage.test.tsx]
issue: 141
source: review
date: 2026-03-26
---
The reviewer caught that setting `emptyResult=true` in the hook without changing `step` left the scanning spinner visible alongside the "All caught up" panel. The hook's `onSuccess` early-return branch didn't call `setStep('review')`, so `step` stayed at `'scanning'` and the spinner condition `step === 'scanning' && !scanError` remained true.

Root cause: state machine thinking gap — when writing an early-return path in a state machine handler, the spec says "friendly empty state replaces the loading UI", but no thought was given to which state variable controls the loading UI. The `step` state is the gatekeeper for the scanning spinner, but the implementation only set `emptyResult` and returned.

What would have prevented it: (1) The test only asserted what WAS present (the "All caught up" panel), not what should NOT be present (the spinner). A negative assertion would have caught the regression immediately. (2) When writing a new exit path in a state machine, always ask "what does the rendering branch for the old state (scanning) still render, and is that correct?"
