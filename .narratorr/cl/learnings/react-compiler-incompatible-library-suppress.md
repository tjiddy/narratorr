---
scope: [frontend]
files: [src/client/pages/settings/ImportSettingsSection.tsx]
issue: 295
date: 2026-04-02
---
Adding `watch()` from react-hook-form triggers a `react-hooks/incompatible-library` lint warning from the React Compiler plugin. The established codebase pattern is to suppress it with `// eslint-disable-next-line react-hooks/incompatible-library`. Multiple files already use this pattern (IndexerCard, NamingSettingsSection, LibrarySettingsSection, etc.). ProcessingSettingsSection doesn't trigger it despite using `watch()` — possibly because the compiler already skips it for other reasons.
