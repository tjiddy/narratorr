---
scope: [backend]
files: [src/server/services/library-scan.service.ts]
issue: 114
date: 2026-03-25
---
Using `as const` on template literal tuples inside `new Map(array.map(...))` causes TypeScript to infer the key as a union of template literal types (e.g., `\`${string}|null\` | \`${string}|${string}\``), which then rejects plain `string` lookups at call sites. Fix: type the Map explicitly as `new Map<string, number>()` and cast inner tuples as `[string, number]` instead of `as const`. Caught late by `pnpm typecheck` after verify.ts was first run.
