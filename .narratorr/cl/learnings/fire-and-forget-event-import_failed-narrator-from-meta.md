---
scope: [backend]
files: [src/server/services/library-scan.service.ts]
issue: 104
date: 2026-03-25
---
When recording failure events (import_failed) in a catch block, still capture enrichment metadata from the outer scope (e.g., `meta?.narrators?.[0]`) even though the import failed — the metadata was resolved BEFORE the failure and provides useful context in the event history. Hardcoding `narratorName: null` in catch blocks silently violates the "include narrator where available" AC requirement. The self-review subagent caught this; the test missed it because the failure test used `null` metadata.
