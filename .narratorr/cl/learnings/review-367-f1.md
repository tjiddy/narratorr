---
scope: [core]
files: [src/core/download-clients/qbittorrent.test.ts]
issue: 367
source: review
date: 2026-04-06
---
Reviewer caught that the unsupported-scheme test only asserted `toThrow()` without checking the error message or verifying no login/upload side effects occurred. A generic throw assertion doesn't prove the rejection happens at the right point — need to assert the specific guard message and that no downstream requests fire. Test gap: always assert both the error contract AND the absence of side effects for early-rejection paths.
