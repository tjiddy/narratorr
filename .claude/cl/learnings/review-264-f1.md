---
scope: [scope/core]
files: [src/core/download-clients/qbittorrent.ts]
issue: 264
source: review
date: 2026-03-08
---
Reviewer caught that `extractInfoHashFromTorrent` decremented dictionary depth when parsing bencoded integer tokens (`i...e`). The `e` ending an integer is NOT a container-closing marker — it should not affect depth. This produced incorrect info hashes for any torrent with integer values in the info dictionary.

**Root cause:** Incomplete understanding of bencode format during implementation. The integer end-marker `e` was conflated with dict/list end-marker `e`.

**Prevention:** When implementing binary format parsers, write unit tests that compute known-good values (e.g., hash a hand-crafted torrent and compare to expected SHA-1). The test should have asserted the hash value, not just that the upload happened.
