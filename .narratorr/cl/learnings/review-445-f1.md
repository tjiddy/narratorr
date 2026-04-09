---
scope: [backend]
files: [src/server/services/cover-upload.ts]
issue: 445
source: review
date: 2026-04-09
---
Reviewer caught that `uploadBookCover()` didn't clean up the temp file when `rename()` failed, violating the "no partial state" spec requirement. The existing `cover-download.ts` pattern also lacks this cleanup, but the download path returns `false` (never throws) so it's less critical. When adding atomic write patterns (temp → rename), always wrap the post-write steps in try/catch with temp file cleanup. The self-review checked "atomicity" but didn't consider the failure path of the rename step specifically.
