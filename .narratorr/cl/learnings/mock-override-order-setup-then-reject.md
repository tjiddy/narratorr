---
scope: [frontend]
files: [src/client/components/library/BulkOperationsSection.test.tsx]
issue: 141
date: 2026-03-26
---
When a test's `setup()` function calls `mockResolvedValue()` internally, setting `mockRejectedValue()` BEFORE calling `setup()` gets silently overwritten — the rejection never fires. Fix: always call `setup()` first, then override with `mockRejectedValue()`. The setup call must come before the error-path override, not after.
