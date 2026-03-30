---
scope: [frontend]
files: [src/client/pages/settings/NamingSettingsSection.tsx]
issue: 212
date: 2026-03-30
---
Large settings section components easily exceed ESLint's cyclomatic complexity (≤15) and max-lines-per-function (≤150) limits. The fix is extracting file-local sub-components (SelectWithChevron, FormatField) that encapsulate repeated DOM patterns. This reduces the main component's complexity without creating separate files for purely internal render helpers. The `registerProps: Record<string, unknown>` type avoids TypeScript issues when spreading RHF register results (which include `ref` that's not in `InputHTMLAttributes`).
