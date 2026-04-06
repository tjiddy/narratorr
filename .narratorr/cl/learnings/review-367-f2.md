---
scope: [core]
files: [src/core/download-clients/qbittorrent.test.ts]
issue: 367
source: review
date: 2026-04-06
---
Reviewer caught that the catch/rethrow branch for network errors was only tested with TimeoutError (DOMException), not with TypeError('fetch failed') which is the path for DNS/connection-refused. Utility-level tests in fetch-with-timeout.test.ts cover the mapping, but the adapter's catch block also needs direct coverage to prove it doesn't accidentally transform these errors. Test gap: when wrapping fetchWithTimeout in try/catch, test both DOMException and TypeError error shapes at the adapter level.
