---
scope: [frontend]
files: [src/client/pages/book/BookDetails.tsx, src/client/pages/book/BookDetails.test.tsx]
issue: 445
source: review
date: 2026-04-09
---
Reviewer caught missing page-level orchestration tests for BookDetails cover upload flow. The self-review and coverage analysis both flagged this gap but classified it as "tested at lower layers." The reviewer correctly identified that component-level callback tests (BookHero) don't catch wiring bugs in the orchestrator (BookDetails). When a page component orchestrates state + mutation + hook, it needs its own integration tests even when child components and hooks are individually tested.
