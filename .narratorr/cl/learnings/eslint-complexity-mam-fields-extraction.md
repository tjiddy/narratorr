---
scope: [frontend]
files: [src/client/components/settings/IndexerFields.tsx]
issue: 339
date: 2026-04-04
---
Adding async blur detection with badge hydration, formTestResult bridge, and language toggles to MamFields easily hits ESLint's complexity limit (15). Prior learning from #317 warned about this. The fix is extracting pure helpers (`deriveInitialMamStatus`, `metadataToMamStatus`) — each ternary/conditional in a helper doesn't count against the parent function's complexity. Extract before writing the component body, not after verify fails.
