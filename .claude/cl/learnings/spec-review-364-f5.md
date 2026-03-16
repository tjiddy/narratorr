---
scope: [scope/frontend]
files: [src/client/pages/book/FileList.tsx]
issue: 364
source: spec-review
date: 2026-03-14
---
Test plan added a loading-indicator requirement that wasn't in the AC. The source code returns null for both `isLoading` and `isError`, but the AC only mentioned error state. Root cause: elaboration noticed both states in the source but only promoted error to the AC while adding loading to the test plan, creating a mismatch. AC and test plan must stay synchronized — if a test case exists, its behavior must appear in the AC.
