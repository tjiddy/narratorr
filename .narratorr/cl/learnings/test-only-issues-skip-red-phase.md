---
scope: [frontend]
files: [src/client/components/settings/NotifierFields.test.tsx, src/client/components/settings/IndexerFields.test.tsx, src/client/components/settings/DownloadClientForm.test.tsx, src/client/pages/library-import/LibraryImportPage.test.tsx]
issue: 201
date: 2026-03-29
---
When an issue is purely about adding test coverage for existing production code (no new features), the red/green TDD "red" phase is inverted — tests pass immediately because the production code already exists. The correct approach is to verify tests exercise real branches by checking assertions target actual DOM elements/classes/text, not to force artificial failures. Vacuous-test concern still applies: ensure assertions are specific enough that removing the production branch would break the test.
