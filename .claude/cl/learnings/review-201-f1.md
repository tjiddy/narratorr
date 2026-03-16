---
scope: [scope/frontend]
files: [apps/narratorr/src/client/pages/book/BookDetails.tsx]
issue: 201
source: review
date: 2026-02-23
---
Chaining two async operations (update + rename) in a single try/catch makes the second operation's failure look like the first one failed. Always separate independent async operations with their own error handling so users get accurate feedback. Also, when bypassing TanStack Query mutations for multi-step async flows, use local `useState` for loading state instead of `mutation.isPending`.
