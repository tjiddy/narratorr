---
scope: [core, services]
files: [src/server/services/match-job.service.ts]
issue: 434
date: 2026-04-08
---
MatchJobService delegates scan work to an inner `MatchJob` class. Adding `settingsService` to MatchJobService's constructor is insufficient — it must also be threaded to the inner class constructor and createJob() call. TypeScript catches this with "property does not exist on type 'MatchJob'" but only if the inner class is what calls `this.settingsService`. Read the full class hierarchy before adding constructor params.
