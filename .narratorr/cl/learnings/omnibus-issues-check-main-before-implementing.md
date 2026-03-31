---
scope: [frontend, backend, core]
files: [src/shared/schemas/settings/registry.ts, src/core/utils/map-network-error.ts]
issue: 227
date: 2026-03-31
---
Omnibus issues with multiple findings may have some findings already implemented on main by the time implementation starts (especially after long spec review cycles). Always verify each finding's current state on main before writing code — saves implementing already-done work. For #227, 3 of 7 findings were already on main.
