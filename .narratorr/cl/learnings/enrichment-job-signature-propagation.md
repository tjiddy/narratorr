---
scope: [backend]
files: [src/server/jobs/enrichment.ts, src/server/jobs/enrichment.test.ts, src/server/__tests__/error-recovery.e2e.test.ts]
issue: 350
date: 2026-04-04
---
Widening a job function signature (e.g., adding `bookService` to `runEnrichment`) requires updating every call site across unit tests, e2e tests, and the job registry wiring. For enrichment.ts, that was 20+ call sites in enrichment.test.ts alone. The spec review correctly flagged that the initial spec only named `jobs/index.ts` — enumerating all callers upfront saves a full review round-trip.
