---
skill: review-pr
issue: 210
pr: 211
round: 2
date: 2026-03-29
new_findings_on_original_code: [F1, F2, F3]
---

### F1: Import flow still lacks direct assertions for non-default naming-options forwarding
**What I missed in round 1:** `ImportService.importDownload()` threads `namingOptions` into `runAudioProcessing()` and `renameFilesWithTemplate()`, but the original review only called out the propagation area broadly and did not force branch-specific assertions for those two downstream calls.
**Why I missed it:** I stopped at the higher-level “service propagation is under-tested” observation instead of decomposing the import flow into independently breakable branches: target-path calculation, processing context, and final file rename.
**Prompt fix:** “When a service computes an options object once and forwards it to multiple downstream helpers, enumerate each downstream call as its own behavior entry. Do not treat ‘service propagation’ as covered unless every call site has a direct assertion or a clearly shared execution path that would fail if any single forwarding edge were removed.”

### F2: `startRenameJob()` still lacks a non-default naming-options batch-filter assertion
**What I missed in round 1:** `BulkOperationService` has two separate path-comparison behaviors (`countRenameEligible()` and `startRenameJob()`), but I only raised the area generally instead of requiring one assertion per method.
**Why I missed it:** The two methods share nearly identical comparison logic, which made it easy to mentally collapse them into one review item even though they can regress independently.
**Prompt fix:** “For duplicated or near-duplicated logic across sibling methods, enumerate coverage per method, not per pattern. If `count*` and `start*` paths both recompute the same derived value, each needs its own behavior entry and test evidence.”

### F3: `audio-processor.ts` still lacks convert-branch naming-options coverage
**What I missed in round 1:** I correctly identified the audio-processing naming-options area, but I did not split merge-output naming and per-file convert-output naming into separate behaviors.
**Why I missed it:** I treated `processAudioFiles()` as a single feature surface instead of auditing both internal branches (`mergeFiles()` and `convertFiles()`) independently.
**Prompt fix:** “Inside functions with branch dispatch (for example merge vs convert), enumerate branch-specific consequences separately. A test on one branch never counts as coverage for the sibling branch unless the assertion demonstrably exercises both.”
