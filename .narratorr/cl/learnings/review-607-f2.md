---
scope: [frontend]
files: [src/client/components/settings/ImportListCard.tsx]
issue: 607
source: review
date: 2026-04-16
---
When migrating local state management to shared hook state (e.g., test connection results moving from local useState to useCrudSettings' formTestResult), any reset/clear logic that was tied to the local state must be replicated. The old ImportListForm cleared testResult on provider change; the migrated form didn't clear formTestResult because it's a prop from the parent hook. Solution: track staleness locally with a `testResultStale` flag that provider changes set and new tests clear.
