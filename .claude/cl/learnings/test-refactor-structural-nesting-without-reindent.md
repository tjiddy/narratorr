---
scope: [backend]
files: [src/server/services/import.service.test.ts]
issue: 96
date: 2026-03-26
---
When structurally nesting describe blocks (moving sibling describes under a parent), you can skip re-indentation — JavaScript/TypeScript and Vitest don't care about whitespace. The test count, assertions, and coverage remain identical. Attempting to re-indent first increases diff noise and merge conflict risk for a purely cosmetic benefit.
