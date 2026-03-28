---
scope: [frontend]
files: [src/client/pages/settings/ImportSettingsSection.tsx]
issue: 186
date: 2026-03-28
---
When replacing a local Zod schema with an imported one (e.g., `stripDefaults(importSettingsSchema)`), the `z` import may become type-only (used only in `z.infer<>`). ESLint's `@typescript-eslint/consistent-type-imports` rule catches this. Always check whether `z` is still used at runtime after schema refactors — if only for type inference, switch to `import type { z }`.
