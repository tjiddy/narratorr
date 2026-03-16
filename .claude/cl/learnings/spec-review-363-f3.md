---
scope: [scope/frontend]
files: [src/client/components/AudioInfo.tsx, src/client/components/icons.tsx]
issue: 363
source: spec-review
date: 2026-03-14
---
Reviewer caught that the icon AC referred to raw Lucide imports generically when the codebase already has shared icon wrappers (`HeadphonesIcon`, `PackageIcon` in `@/components/icons`). The `/elaborate` subagent actually found these wrappers but the AC was written with generic names anyway.

Root cause: Subagent findings about shared icon wrappers were in the ephemeral codebase findings section but weren't propagated into the AC text.

Prevention: When the subagent identifies existing shared abstractions (icon wrappers, helpers, registries), the AC should reference those by name rather than the underlying library.
