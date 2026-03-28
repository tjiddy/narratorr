---
scope: [frontend]
files: [src/client/pages/settings/ScheduledTasks.test.tsx]
issue: 279
source: review
date: 2026-03-10
---
Mutation handlers with invalidateQueries on both onSuccess and onError need separate tests for each path proving the query refetches. Pattern: record the query function call count before the mutation, trigger the mutation (success or failure), then assert the call count increased. Both paths matter — error-path invalidation is easy to accidentally remove.
