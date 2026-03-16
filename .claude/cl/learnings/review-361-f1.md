---
scope: [backend, services]
files: [src/server/utils/import-steps.ts, src/server/services/import.service.ts]
issue: 361
source: review
date: 2026-03-16
---
When extracting error handling code, the failure notification used `book.title` instead of `download.title`. These diverge because download names come from torrent/nzb releases (e.g., "Author - Book [2024] [MP3]") while book titles are clean metadata. The self-review didn't catch this because both are "title" strings with similar roles. Fix: when extracting, diff each field in the original vs extracted version and ask "are these the same variable?" for every data source.
