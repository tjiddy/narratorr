---
scope: [backend]
files: [src/server/utils/find-or-create-person.ts]
issue: 482
source: review
date: 2026-04-12
---
When the spec says "single shared utility," reviewer expects a single core algorithm — not two functions with duplicated logic. Even when author/narrator differ by ASIN backfill, the core select→insert→retry pattern should be a private helper with the domain-specific bits parameterized via callbacks. Would have been caught by stricter DRY-2 self-review before handoff.
