---
skill: respond-to-pr-review
issue: 117
pr: 122
round: 1
date: 2026-03-25
fixed_findings: [F1]
---

### F1: errorMessage write not tested together with retry overwrite path

**What was caught:** The new `processDownloadUpdate()` write of `item.errorMessage` to `downloads.errorMessage` was not directly tested together with the subsequent retry-state overwrite in a single execution flow. The existing test at line 299 covered the no-retry path (`bookId: null`), and the existing retry tests used `adapter.getDownload() → null` (the "not found" path), meaning no test exercised `processDownloadUpdate()` → `handleFailureTransition()` → `handleDownloadFailure()` in sequence.

**Why I missed it:** The spec's ordering contract ("write adapter error message on initial failure detection, then retry-state text overwrites it") was tested by covering each side effect independently — the initial write in one test, the retry-state write in another. The ordering contract was implicitly satisfied by the implementation but never explicitly verified. I didn't recognize that "A before B on the same path" is a different contract than "A happens" and "B happens" separately.

**Prompt fix:** Add to `/implement` step 4 (after TDD loop): "When a spec item defines a sequencing contract ('X happens before Y' or 'X on initial detection, then Y overwrites it'), verify that at least one test exercises the full sequence in a single execution call — not just each side effect in isolation. Look for spec language like 'before', 'then', 'initially', 'subsequently', 'overwrites'."
