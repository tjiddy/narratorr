---
scope: [scope/frontend, scope/backend]
files: [src/client/hooks/useLibrarySearch.ts]
issue: 372
source: spec-review
date: 2026-03-15
---
When replacing a client-side feature with a server-side equivalent (e.g., Fuse fuzzy search → SQL LIKE), the spec must explicitly document the behavior change as intentional vs accidental. Reviewers will flag narrowed functionality as a regression unless the spec says "this is deliberate because X." Also verify the search fields match — the original spec missed genres.
