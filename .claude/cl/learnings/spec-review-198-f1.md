---
scope: [scope/backend]
files: []
issue: 198
source: spec-review
date: 2026-03-12
---
Spec claimed scripts would "run outside the processing semaphore" without defining a detached execution model, and didn't list which import entry points trigger the hook. The codebase has two entry points to `importDownload()` (cron job + manual approve), both wrapped in semaphore acquire/release. Specs adding phases to the import pipeline must explicitly state: (1) whether the phase runs inside or outside the semaphore, (2) which entry points trigger it. The `/elaborate` skill should have checked the semaphore boundary when the scope boundaries section claimed "outside semaphore."
