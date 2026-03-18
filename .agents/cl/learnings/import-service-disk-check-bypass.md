---
scope: [backend]
files: [src/server/services/import.service.test.ts]
issue: 198
date: 2026-03-12
---
Import service tests that don't need to test disk space behavior should set `minFreeSpaceGB: 0` in the import settings mock. This skips the `statfs` call entirely, avoiding the need to mock `node:fs` or deal with platform-specific filesystem APIs. The tag embedding tests already use this pattern.
