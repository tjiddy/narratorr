---
scope: [backend, core]
files: [src/core/notifiers/pushover.test.ts, src/core/notifiers/telegram.test.ts, src/core/notifiers/ntfy.test.ts]
issue: 199
source: review
date: 2026-03-29
---
When testing HTTP error responses that format as `HTTP <status>: <body>`, asserting only the status code (`.toContain('400')`) is insufficient — it doesn't prove the response text is preserved. Always assert both the status code AND the response body text to verify the full error message format contract.
