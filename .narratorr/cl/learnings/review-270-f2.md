---
scope: [core]
files: [src/core/download-clients/transmission.test.ts]
issue: 270
source: review
date: 2026-04-01
---
When testing retry/retry-once behavior, asserting only the final outcome (success: false) doesn't prove the retry happened. Use a counting handler to verify exactly N requests were made, and assert the exact error message. `toContain('409')` is too loose — it doesn't distinguish between immediate-fail and retry-then-fail. Root cause: test was written to verify the outcome but not the mechanism (retry count).
