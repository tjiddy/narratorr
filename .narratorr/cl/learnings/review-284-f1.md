---
scope: [backend]
files: [src/shared/schemas/download-client.test.ts]
issue: 284
source: review
date: 2026-04-01
---
Whitespace-only empty-string contract tests must use a truly optional field to verify the trim output. Testing against a superRefine-required field (like `host` for qbittorrent) only proves parse failure, not that the trimmed value is `''` vs `undefined`. Use non-required optional fields (e.g., `category`, `watchDir`) for the positive contract assertion.
