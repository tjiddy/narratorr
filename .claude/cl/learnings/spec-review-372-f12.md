---
scope: [scope/frontend]
files: [src/client/pages/activity/EventHistorySection.tsx]
issue: 372
source: spec-review
date: 2026-03-15
---
When specifying pagination reset rules for filter changes, check ALL filter inputs on the page — not just the obvious ones. Event history had both a type pill filter and a search input, but the initial spec only mentioned resetting on type filter changes. Any input that changes the result set needs the same pagination reset.
