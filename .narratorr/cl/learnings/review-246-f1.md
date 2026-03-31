---
scope: [frontend]
files: [src/client/pages/search/SearchTabContent.tsx]
issue: 246
source: review
date: 2026-03-31
---
When a spec says "prominent CTA that opens form on click," mounting the form immediately is not the same thing. The zero-result path should have followed the same CTA→toggle pattern as the results-present path. The self-review passed this because it checked text presence, not interaction behavior.
