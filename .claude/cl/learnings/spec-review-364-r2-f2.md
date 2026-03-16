---
scope: [scope/frontend]
files: [src/client/pages/search/SearchTabContent.tsx, src/client/components/SearchReleasesModal.tsx]
issue: 364
source: spec-review
date: 2026-03-14
---
Round 1 added a test case for "duplicate results (same asin) render independently" but the key contract still started with `asin ??` — meaning two results with the same ASIN would produce the same key. The test plan required uniqueness that the AC didn't guarantee. Root cause: when a test plan exercises a collision scenario, the key contract must explicitly define the tie-break strategy. Always pair "what makes it stable" with "what makes it unique."
