---
scope: [frontend]
files: [src/client/pages/settings/NamingSettingsSection.test.tsx]
issue: 217
source: review
date: 2026-03-30
---
When testing cursor-position-dependent insertion (`insertTokenAtCursor`), `toContain` is insufficient — it doesn't prove WHERE the token was inserted. Always assert the exact resulting string value when the spec defines position-specific behavior (e.g., append at end, insert at cursor). The coverage review subagent flagged the weak assertion but suggested value-checking without requiring exact position proof.
