---
scope: [frontend]
files: [src/client/components/Button.tsx, src/client/pages/activity/DownloadActions.tsx, src/client/components/settings/SettingsCardShell.tsx]
issue: 162
date: 2026-03-28
---
When migrating hand-rolled buttons to a shared Button component with solid variants (bg-destructive, bg-success), callers that used "soft" (bg-X/10) styling silently change visual appearance. This is intentional standardization, but should be called out in the spec as a design decision rather than discovered during migration. The spec's test plan only checks variant class names, not the full chain of how callers previously used opacity-based backgrounds.
