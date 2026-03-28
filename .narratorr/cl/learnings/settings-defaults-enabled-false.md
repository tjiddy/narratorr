---
scope: [backend]
files: [src/server/jobs/rss.test.ts]
issue: 392
date: 2026-03-15
---
When migrating test fixtures to a shared factory backed by DEFAULT_SETTINGS, remember that `rss.enabled` defaults to `false` in the registry. Tests that previously had local wrappers with `enabled: true` as the default silently broke when moved to the shared factory because the RSS job exits early when disabled. Always audit each local wrapper's defaults against DEFAULT_SETTINGS before migration.
