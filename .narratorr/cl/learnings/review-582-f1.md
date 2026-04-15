---
scope: [frontend]
files: [src/client/hooks/index.ts, src/client/hooks/useFocusTrap.test.tsx]
issue: 582
source: review
date: 2026-04-15
---
When creating a new barrel export file, always add a smoke test that imports from the barrel and verifies the export matches the direct module export (`expect(barrelExport).toBe(directExport)`). Without this, the barrel could be deleted or mis-export without any test failure. The barrel-export-before-consumer-wiring learning covered ordering but not proving the barrel actually works.
