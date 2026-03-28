---
scope: [scope/backend, scope/services]
files: [src/server/services/discovery.service.ts]
issue: 408
source: review
date: 2026-03-17
---
Resurfaced snoozed rows used a hardcoded weight-based fallback instead of the real scoreCandidate algorithm. This meant resurfaced rows lost duration/recency/series bonuses. The gap was that the resurfacing path was treated as a separate concern from scoring, when AC6 explicitly requires "fresh score" via the same logic. Should have reused scoreCandidate from the start by constructing a pseudo-BookMetadata from the stored suggestion fields.
