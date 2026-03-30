---
scope: [frontend, core]
files: [src/shared/schemas/settings/general.ts, src/shared/schemas/settings/discovery.ts, src/shared/schemas/settings/quality.ts]
issue: 215
source: review
date: 2026-03-30
---
Reviewer caught that form schemas were hand-copied instead of derived from settings schemas. We originally used stripDefaults() but fell back to manual copies when TypeScript types were lost. The fix is to keep the runtime derivation via stripDefaults() and add a type cast annotation. This satisfies both the DRY/ZOD-2 AC and TypeScript. Lesson: when a Zod utility loses types, use a type cast on the derived result rather than abandoning the derivation approach entirely.
