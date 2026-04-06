---
scope: [backend]
files: [src/server/services/cover-download.ts]
issue: 369
source: review
date: 2026-04-06
---
When a cover image is re-downloaded with a different content-type (e.g., PNG → JPEG), the old cover file persists as a sibling. The serving route uses readdir + first regex match, so the stale file can be served instead of the new one. Fix: after atomic rename, scan for and unlink any `cover.*` siblings that don't match the new extension. This was missed because the initial implementation focused on the atomic rename overwriting the *same* filename, not considering extension changes.
