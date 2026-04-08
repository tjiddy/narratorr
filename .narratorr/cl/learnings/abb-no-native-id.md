---
scope: [core]
files: [src/core/indexers/abb.ts]
issue: 410
date: 2026-04-08
---
ABB has no native torrent ID (unlike MAM's `item.id`). The only stable identifier available is `infoHash` from the detail page. For ABB, `guid = infoHash` (a copy). This differs from MAM where `guid` and `infoHash` are independent identifiers. Future ABB work should not assume a separate torrent ID exists.
