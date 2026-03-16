---
scope: [scope/frontend]
files: [src/client/pages/settings/GeneralSettings.test.tsx]
issue: 341
source: review
date: 2026-03-12
---
Reviewer caught that the page-level test didn't verify cross-section dirty-state isolation — the key architectural property of per-section forms. When one section saves and triggers cache invalidation, other dirty sections must preserve their unsaved changes (via the `!isDirty` guard in useEffect). This is the core behavioral contract of the refactor and should have had a dedicated integration test from the start.
