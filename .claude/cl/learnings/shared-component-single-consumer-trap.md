---
scope: [frontend]
files: [src/client/components/EmptyState.tsx, src/client/pages/search/SearchResults.tsx]
issue: 99
date: 2026-03-25
---
A component named generically (e.g., `EmptyState`) looks like a shared abstraction, but grepping imports reveals a single consumer. Spec and elaboration assumed broad reuse across Discover/Author/Book pages — code search contradicted this. Each of those pages uses its own bespoke empty-state markup. Always verify actual import count before writing scope boundaries or regression tests around "shared" components.
