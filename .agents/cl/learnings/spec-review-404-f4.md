---
scope: [scope/backend]
files: []
issue: 404
source: spec-review
date: 2026-03-17
---
The reviewer caught that the AC4 implementation reference pointed to `discovery-weights.ts` instead of `discovery.service.ts` where `SIGNAL_WEIGHTS` actually lives. The spec confused base signal weights (in `discovery.service.ts`) with dismissal-based multipliers (in `discovery-weights.ts`). Prevention: when documenting "implemented in" references, verify the exact file:line for the specific constant or function being cited — don't conflate files with similar names.