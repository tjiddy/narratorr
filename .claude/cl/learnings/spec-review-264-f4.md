---
scope: [scope/core]
files: [src/core/indexers/fetch.ts]
issue: 264
source: spec-review
date: 2026-03-08
---
Spec required session rotation (persisting updated `mam_id` from `Set-Cookie`) without checking that `fetchWithProxy` returns only `string` — response headers are discarded. Features requiring response metadata beyond the body need fetch-layer interface changes, which should be scoped as a separate prerequisite or deferred.
