---
scope: [scope/frontend]
files: [src/client/index.html, src/client/lib/theme-bootstrap.ts, src/client/lib/theme-bootstrap.test.ts, src/client/pages/login.test.tsx]
issue: 8
source: review
date: 2026-03-19
---
Inline IIFE logic in index.html cannot be unit tested. Pre-seeding DOM state in component tests (e.g., `document.documentElement.classList.add('dark')`) and then asserting the component didn't undo it does not exercise the selection logic — deleting the bootstrap script would leave those tests green. Any logic in an inline HTML script that has testable decision branches (localStorage + matchMedia → class toggle) should be extracted into a TypeScript module and tested directly. Keep the IIFE for FOUC prevention but mirror the logic in the module.
