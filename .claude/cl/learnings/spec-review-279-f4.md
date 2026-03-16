---
scope: [scope/backend]
files: [src/shared/schemas/settings/import.ts, src/shared/schemas/settings/system.ts]
issue: 279
source: spec-review
date: 2026-03-10
---
Spec mentioned "configurable threshold" for disk space health warning without specifying where the threshold lives. The existing `minFreeSpaceGB` is in import settings, not system settings. Specs that reference "configurable X" must name the exact setting field and its schema location — ambiguity leads to duplicate or misplaced config.
