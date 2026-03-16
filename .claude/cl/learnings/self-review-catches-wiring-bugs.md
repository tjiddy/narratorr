---
scope: [backend]
files: [src/server/jobs/index.ts]
issue: 279
date: 2026-03-10
---
The self-review step caught 2 critical integration bugs: a job function defined but never called in startJobs(), and a registry created but never populated. Unit tests passed because each module was tested in isolation — the wiring gaps only surface when you trace the full startup path. Always verify new services are actually wired into the app bootstrap, not just instantiated.
