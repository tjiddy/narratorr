---
scope: [frontend]
files: [src/client/pages/settings/NamingSettingsSection.tsx, src/client/pages/settings/NamingSettingsSection.test.tsx]
issue: 217
date: 2026-03-30
---
When testing repeated sub-components (like two `FormatField` instances), DOM traversal via `closest('div').parentElement` is unreliable because nesting depth varies. Use `data-testid` attributes and `getAllByTestId()` with index-based selection (e.g., `previews[0]` = folder, `previews[1]` = file) for deterministic scoping.
