---
scope: [backend]
files: [src/server/jobs/index.ts, src/server/services/task-registry.ts]
issue: 279
source: review
date: 2026-03-10
---
TaskRegistry was a metadata observer disconnected from actual job execution. The start*Job() functions ran cron/timeout callbacks independently while the registry only tracked manual runTask() calls. Fix: centralize all scheduling in startJobs() using registry.executeTracked() for cron jobs and registry.setNextRun() for timeout loops. This is an architectural gap — when building an instrumentation/observability layer, it must sit ON the execution path, not parallel to it.
