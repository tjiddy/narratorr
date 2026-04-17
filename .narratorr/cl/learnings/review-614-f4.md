---
scope: [infra]
files: [e2e/fixtures/seed.test.ts, e2e/fixtures/seed.ts]
issue: 614
source: review
date: 2026-04-17
---
Added new DB side effects to `seedE2ERun` (three new settings rows: `general`, `library`, `import`) without adding co-located DB assertions. Only the E2E critical-path test would have caught a regression, and only on a host where the disk-space gate actually trips. Lesson: when a helper gains new side effects, the existing co-located test file MUST grow assertions covering them in the same commit — not deferred to "integration will catch it." Seed/factory helpers are especially prone to this because their side effects are easy to add and silent to regress.
