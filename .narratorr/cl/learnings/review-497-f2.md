---
scope: [frontend]
files: [src/client/pages/author/helpers.test.ts]
issue: 497
source: review
date: 2026-04-12
---
Test fixtures used idealized full-date values (`2024-06-15`) but the real data path was year-only at the time. Tests should include at least one fixture that mirrors the actual data shape from the upstream provider. For sort tests specifically, include a same-bucket case (e.g., same-year books) to verify sub-bucket ordering.
