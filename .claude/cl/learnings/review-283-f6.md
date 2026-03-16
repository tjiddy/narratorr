---
scope: [backend]
files: [src/server/services/import.service.ts]
issue: 283
source: review
date: 2026-03-10
---
When adding SSE emissions to an import flow, the importing→imported transition for the *download* record was missed while the book_status_change and import_complete emissions were added. Every DB status update (`UPDATE downloads SET status = ...`) should have a corresponding `download_status_change` emission. Systematic checklist: grep for all `.set({ status:` calls in the service and verify each has a corresponding emission.
