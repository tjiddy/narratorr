---
scope: [core]
files: [src/core/indexers/abb.ts]
issue: 410
date: 2026-04-08
---
ABB adapter drops results without `downloadUrl` in `enrichAndCollect` (line 89), and `downloadUrl` requires `infoHash`. This means tests cannot assert `guid: undefined` on returned results — those results never exist. Spec review caught this mismatch (F2). When writing test plans for ABB, only assert on observable outputs of `search()`, not internal parse states.
