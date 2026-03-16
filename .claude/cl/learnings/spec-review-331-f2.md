---
scope: [scope/backend]
files: [src/shared/schemas/settings/general.ts]
issue: 331
source: spec-review
date: 2026-03-10
---
Spec said "retention period configurable, default 30, 0 = disabled" without naming the settings key or acknowledging that the existing `housekeepingRetentionDays` has `min(1)` and `default(90)`. An implementer couldn't tell if this was a new key or a change to the existing one. Prevention: when a feature adds a new setting, always name the exact schema key, its Zod constraints, and explicitly state whether it's new or modifying an existing field. Check the live schema before writing defaults.
