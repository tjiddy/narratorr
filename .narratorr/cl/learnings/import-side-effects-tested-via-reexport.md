---
scope: [backend]
files: [src/server/utils/import-side-effects.ts, src/server/utils/import-steps.test.ts]
issue: 483
date: 2026-04-12
---
`import-side-effects.ts` has no co-located test file — its functions are re-exported by `import-steps.ts` and tested in `import-steps.test.ts`. The coverage check script flags this as "MISSING TEST" but it's a false positive. This barrel re-export pattern means tests live with the consumer, not the source.
