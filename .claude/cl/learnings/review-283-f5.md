---
scope: [backend]
files: [src/server/services/quality-gate.service.ts]
issue: 283
source: review
date: 2026-03-10
---
When adding SSE emissions to a service, every status transition must emit `download_status_change`, not just the ones that happen to be near existing code. The quality gate service has multiple transition paths (atomicClaim: completed→checking, hold: checking→pending_review, auto-import: checking→completed, auto-reject: checking→failed) and all need emissions. A private `setStatus()` helper is tempting to instrument, but it lacks book context — emit at the call sites where both download and book IDs are available.
