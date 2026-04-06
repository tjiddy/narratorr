---
scope: [core]
files: [src/core/download-clients/deluge.ts]
issue: 373
date: 2026-04-06
---
Deluge's `Seeding` state does NOT mean the download is complete — `is_finished` is the authoritative flag. A torrent can be in `Seeding` state while `is_finished=false` (e.g., partial seeding). Existing tests that asserted `Seeding→seeding` had to be updated to account for the `is_finished` flag, which changed the mock fixture contract.
