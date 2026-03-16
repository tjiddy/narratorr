---
scope: [scope/backend, scope/api]
files: [src/server/routes/system.ts, src/server/plugins/auth.ts]
issue: 279
source: spec-review
date: 2026-03-10
---
When a spec declares a soft dependency on an unmerged PR, all references to shared artifacts must be conditional on merge order — not hardcoded to either the pre-merge or post-merge shape. The spec said "either merge order is valid" but then hardcoded the pre-#335 `/api/system/status` shape in tests, which contradicts the claim. Use "preserve whatever exists at implementation time" with explicit conditionals for each path.
