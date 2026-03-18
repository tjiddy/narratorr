---
scope: [backend, services]
files: [src/server/jobs/monitor.ts, src/server/services/types.ts]
issue: 360
date: 2026-03-14
---
When decomposing a function and introducing local type aliases for the extracted helpers, check whether those types already have a shared definition. In #360, extracting monitor helpers created a new local `type DownloadRow` that duplicated the one we'd just centralized in `services/types.ts`. The self-review caught it, but the blast-radius check after the type dedup commit should have caught it first — grep for all remaining instances of the pattern, not just the files listed in the spec.
