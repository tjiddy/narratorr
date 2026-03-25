---
scope: [frontend]
files: [src/client/pages/manual-import/useManualImport.ts, src/client/pages/manual-import/ManualImportPage.tsx]
issue: 81
date: 2026-03-25
---
TanStack Query's `useMutation` `onSuccess` callback receives `(data, variables, context)` — `variables` is the value passed to `mutate()`. Use this instead of capturing the value via closure to pass the scanned path to side-effect callbacks like `onScanSuccess`. This pattern keeps `useManualImport` focused and allows optional injection of scan-complete side effects without the hook knowing about folder history.
