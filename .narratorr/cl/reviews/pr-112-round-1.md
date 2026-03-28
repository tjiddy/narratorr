---
skill: respond-to-pr-review
issue: 112
pr: 131
round: 1
date: 2026-03-26
fixed_findings: [F1, F2, F3, F4]
---

### F1: Frontend merge gate used recursive audioFileCount instead of top-level count
**What was caught:** `canMerge` used `audioFileCount > 1` which counts all audio files recursively. Books with disc subdirectories (e.g., Disc 1/*.mp3) pass this check but the backend rejects with NO_TOP_LEVEL_FILES.
**Why I missed it:** Didn't trace how audioFileCount is populated (via recursive scanAudioDirectory). Assumed audioFileCount was a proxy for top-level files.
**Prompt fix:** Add to /plan step "Frontend eligibility checks": "When deriving a UI gate from a DB field, explicitly verify that the field's population path (which scan/readdir populates it) matches the backend validation's scope (recursive vs non-recursive). If mismatched, a new schema field is needed."

### F2: Post-commit enrichment failure silently returned success
**What was caught:** `enrichBookFromAudio` returning `{ enriched: false }` only triggered a log.warn; the service still emitted merge_complete and returned 200. The user had no visibility into the partial failure.
**Why I missed it:** Treated "merge succeeded on disk" as the success condition, without explicitly checking what the spec meant by "surface error" for post-commit failures.
**Prompt fix:** Add to /implement checklist for multi-step operations: "For each step after the irreversible commit point, define the user-visible outcome for partial failure. Verify with a test that asserts the response body or toast for 'step N succeeded but step N+1 failed'."

### F3: Output file could be deleted by originals loop if basename collides
**What was caught:** After `rename()` moves the staged M4B to `outputPath`, the deletion loop iterates `originalsToDelete` without excluding the output's filename. If an original shared the same basename, the freshly moved file is deleted.
**Why I missed it:** All test fixtures used .mp3 originals only; no test exercised a source directory containing a pre-existing .m4b alongside other files.
**Prompt fix:** Add to /plan test matrix for staging/commit workflows: "Include a test case where an original file has the same name as the expected output — verifies the commit step doesn't delete what it just created."

### F4: Route test missing NO_PATH 400 branch
**What was caught:** The merge route suite had tests for 5 of the 6 MergeError codes; NO_PATH was not covered at the route level despite being in the ERROR_REGISTRY.
**Why I missed it:** Tests were written in service guard order but NO_PATH was accidentally skipped during enumeration.
**Prompt fix:** Add to /implement route test checklist: "For every code in the error class's ERROR_REGISTRY entry, there must be a corresponding route inject() test. Mechanically enumerate the codes when writing tests rather than stopping when you feel coverage is sufficient."
