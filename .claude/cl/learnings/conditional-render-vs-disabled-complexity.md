---
scope: [frontend]
files: [src/client/pages/settings/ProcessingSettingsSection.tsx]
issue: 66
date: 2026-03-24
---
Replacing `opacity-40` disabled wrappers with `{enabled && <div>}` conditional rendering reduces cyclomatic complexity (the `eslint-disable complexity` directive became unnecessary and triggered a lint violation). Test assertions must change from `.toBeDisabled()` to `.not.toBeInTheDocument()` for conditionally-rendered fields. Always grep test files for `.toBeDisabled()` when changing opacity-disabled patterns to conditional render.
