---
scope: [frontend]
files: [src/client/hooks/useCrudSettings.ts, src/client/pages/settings/ImportListsSettings.tsx]
issue: 364
date: 2026-03-14
---
When migrating a component to `useCrudSettings`, the toast messages change to the hook's pattern (`"${entityName} added successfully"`, `"${entityName} removed successfully"`) instead of the original component's messages. Existing tests that assert specific toast messages will fail. Always check for toast.success/toast.error assertions in the test file before adopting the hook.
