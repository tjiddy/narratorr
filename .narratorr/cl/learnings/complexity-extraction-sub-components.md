---
scope: [frontend]
files: [src/client/components/book/MetadataResultItem.tsx]
issue: 627
date: 2026-04-17
---
When extracting a shared component with multiple conditional render branches (boolean flags for optional rows), ESLint `complexity` easily exceeds 15. Extract private sub-components (`CoverImage`, `MetadataDetails`) within the same file to distribute branches — this keeps the public API unchanged while satisfying the linter. Plan for this upfront when a component has 4+ conditional sections.
