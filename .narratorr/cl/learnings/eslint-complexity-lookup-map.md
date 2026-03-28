---
scope: [frontend]
files: [src/client/pages/library/helpers.ts]
issue: 282
date: 2026-03-10
---
ESLint's `complexity` rule counts each case in a switch statement as a branch. A switch with 8 cases (sorting by different fields) hit complexity 18 vs max 15. Converting to a `Record<string, (book) => value>` lookup map + single `compareNullable` call reduces complexity to 1. This is the go-to pattern for field-based dispatch that grows over time.
