---
scope: [frontend, core]
files: [src/client/components/settings/IndexerFields.tsx, src/client/components/settings/IndexerCard.test.tsx, src/shared/indexer-registry.test.ts]
issue: 372
date: 2026-04-06
---
Removing the MAM search type dropdown cascaded to 9 test failures across 3 test files (IndexerCard.test.tsx, IndexerFields.test.tsx, indexer-registry.test.ts). The dropdown was tested in both the field component and the card component, plus registry defaults. When removing a UI element, grep all test files for the label text and related form field names — the blast radius is always wider than the component file itself.
