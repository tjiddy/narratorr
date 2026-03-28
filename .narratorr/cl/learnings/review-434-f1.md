---
scope: [scope/backend, scope/services]
files: [src/server/services/download-orchestrator.ts]
issue: 434
source: review
date: 2026-03-18
---
When splitting SSE side effects by bookId presence, the orphan-download else branch fabricated `book_id: 0` to satisfy the SSE payload shape. This broke the prior contract where orphaned downloads didn't emit `download_status_change` at all. The fix was to skip SSE entirely for orphaned downloads. Pattern: when the original code only emits conditionally (`if (download.bookId)`), the extraction should preserve that conditional, not invent a default to fill the else branch.
