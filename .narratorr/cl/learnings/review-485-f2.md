---
scope: [frontend]
files: [src/client/hooks/useSettingsForm.ts, src/client/pages/settings/SystemSettings.test.tsx]
issue: 485
source: review
date: 2026-04-12
---
Using a blanket `catch {}` to tolerate partial test mocks hides real runtime errors. The correct fix is to make test mocks complete (using `createMockSettings()` factory) rather than making production code silently swallow selector failures. Partial mocks that only provide one settings category will crash generic `select(settings)` calls — fix the mocks, not the production code.
