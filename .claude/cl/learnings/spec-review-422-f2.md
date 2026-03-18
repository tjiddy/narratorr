---
scope: [scope/backend, scope/services]
files: []
issue: 422
source: spec-review
date: 2026-03-17
---
Spec enumerated three `markFailed()` error cases but missed a fourth: the download row being deleted while the event still references it via FK. Root cause: read the service code and saw the `!event.downloadId` check but didn't continue reading to the next conditional (`!download`) which handles a different failure mode (FK target missing vs FK null). Fix: when enumerating error paths in a function, read every throw/return-error in the function body, don't stop after finding the "obvious" ones.
