---
scope: [frontend]
files: [src/client/pages/settings/SearchSettingsSection.tsx]
issue: 439
date: 2026-04-09
---
Settings section components are at or near the 150-line ESLint `max-lines-per-function` limit. Adding a new form field (dropdown + label + description) adds ~12 lines. To stay under the limit: extract repeated className strings into a helper constant (like `inputClass`), and collapse single-line description `<p>` tags. A `watch()` call from react-hook-form triggers the `react-hooks/incompatible-library` lint rule — use static descriptions instead.