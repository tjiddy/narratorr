---
scope: [frontend]
files: [src/client/components/PageLoading.test.tsx]
issue: 595
source: review
date: 2026-04-15
---
When threading a new prop from a parent caller to a shared component, the parent test must assert the prop's observable effect — not just that the child renders. We tested the shared component (icons.test.tsx) and one caller (LazyRoute.test.tsx) but missed the other caller (PageLoading.test.tsx). The test plan listed "existing PageLoading test still passes" which is a regression check, not a positive assertion. Each caller that threads a new prop needs its own assertion.
