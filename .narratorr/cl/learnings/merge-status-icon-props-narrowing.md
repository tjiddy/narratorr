---
scope: [frontend]
files: [src/client/components/MergeStatusIcon.tsx, src/client/hooks/useMergeProgress.ts]
issue: 465
date: 2026-04-11
---
When extracting a shared component from consumers with different prop shapes (MergeCardState vs inline object), design the shared component's props as the minimal intersection — `{ outcome?: MergeOutcome; phase: string }` — rather than accepting either full state object. This forces callers to destructure explicitly and prevents the component from depending on unrelated fields.