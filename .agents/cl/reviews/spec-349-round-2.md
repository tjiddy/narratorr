---
skill: respond-to-spec-review
issue: 349
round: 2
date: 2026-03-15
fixed_findings: [F5]
---

### F5: Extracted-phase context missing download row for torrent removal
**What was caught:** The shared context listed `downloadId` but torrent removal calls `handleTorrentRemoval(download, minSeedTime)` which needs the full `DownloadRow`.
**Why I missed it:** When defining the phase context in round 1, I listed the fields used by most phases (book, author, targetPath, etc.) but only checked `downloadId` usage for notification/event-history payloads. I didn't trace the torrent-removal call chain to `handleTorrentRemoval`'s signature at line 589.
**Prompt fix:** Add to `/elaborate` step 10 deep source analysis: "When defining a shared context type for extracted functions, trace every consumer's full call surface — read function signatures and field access, not just the call site in the parent method. A foreign key ID is not sufficient when the consumer needs the full row."
