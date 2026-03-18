---
scope: [scope/frontend]
files: [src/client/pages/discover/DiscoverPage.tsx]
issue: 367
source: review
date: 2026-03-16
---
The no-suggestions branch returned an early `<DiscoverEmpty>` without the page header, so users lost the Refresh button and hero count in the exact state where the empty state copy says "hit Refresh". Missed because we focused on the happy path and didn't verify that all empty states still had the necessary affordances. Prevention: when adding empty states that reference actions ("hit Refresh"), verify the action is rendered in that branch.
