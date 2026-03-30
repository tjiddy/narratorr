---
scope: [frontend]
files: [src/client/lib/format.test.ts]
issue: 224
source: review
date: 2026-03-30
---
Fallback branch tests must assert the POSITIVE contract (equals expected value), not just rule out other branches. `expect(result).not.toContain('ago')` only proves the result ISN'T relative — it could be any garbage string. Assert `expect(result).toBe(new Date(input).toLocaleDateString())` to prove the fallback actually calls the expected absolute-date formatter.
