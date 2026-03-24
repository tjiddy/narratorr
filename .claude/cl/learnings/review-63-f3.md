---
scope: [backend]
files: [src/shared/download-status-registry.ts, src/shared/download-status-registry.test.ts]
issue: 63
source: review
date: 2026-03-24
---
Helper functions that define policy boundaries (what statuses are replaceable, what statuses trigger a particular flow) must have direct tests asserting their exact output — not just tests that indirectly exercise them through higher-level callers. A regression in `getReplacableStatuses()` returning a wrong set would silently break the entire replacement feature with no direct test failure.
