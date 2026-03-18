---
scope: [scope/backend, scope/db]
files: []
issue: 429
source: spec-review
date: 2026-03-17
---
AC2/AC3 overstated notification-event centralization — the scope boundary explicitly excludes per-adapter EVENT_TITLES/SUBJECTS maps, but the ACs promised "ONE registry entry" and "zero duplicates across all layers" which contradicts the scope boundary. The elaboration wrote scope boundaries correctly but didn't cross-check them against the ACs for consistency. Would have been caught by: "for each AC, verify it doesn't promise outcomes that the scope boundaries explicitly exclude."
