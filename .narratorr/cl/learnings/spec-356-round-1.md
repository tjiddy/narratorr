---
skill: respond-to-spec-review
issue: 356
round: 1
date: 2026-03-14
fixed_findings: [F1, F2, F3, F4]
---
### F1: AC1/AC4 describe incompatible batching strategies
**What was caught:** Full-table prefetch (AC1) doesn't use `IN(...)`, so the >999 chunking requirement (AC4) was irrelevant to library scan but applied generically.
**Why I missed it:** The elaboration skill added chunking as a blanket AC without mapping each fix's specific query shape. "Pre-fetch all" and "chunk IN(...) at 999" are different strategies that were conflated.
**Prompt fix:** Add to `/elaborate` step 4 test plan gap-fill: "For each batching AC, identify the specific query shape (full-table select vs IN(...) batch) and only apply chunking requirements to IN(...) patterns. Do not apply generic chunking to full-table prefetch strategies."

### F2: Activity route batch lookup missing chunking coverage
**What was caught:** The activity route's new `IN(...)` batch query also needs >999 chunking, but the test plan only covered library scan.
**Why I missed it:** The elaboration skill's DEFECT VECTORS section identified the activity route N+1 but didn't trace through to the replacement query shape to check if it would also hit SQLite limits.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt (deep source analysis): "For each N+1 fix, determine the replacement query shape. If the fix introduces an IN(...) query, verify the test plan covers the >999 parameter limit for that specific query site."

### F3: Source reference to non-existent file
**What was caught:** `debt-scan-findings.md` doesn't exist in the repo; should reference `.narratorr/cl/debt.md`.
**Why I missed it:** Copied the source reference from the original issue without verifying the file exists.
**Prompt fix:** Add to `/elaborate` step 6 (verify fixes): "Verify all file path references in the spec body exist in the repo (ls or git check-ignore)."

### F4: Missing affected test files list
**What was caught:** Refactor will change service call shapes in 4 test files, but spec didn't call this out.
**Why I missed it:** The elaboration subagent found the test files but they were treated as ephemeral codebase findings rather than durable spec content.
**Prompt fix:** Add to `/elaborate` step 4 durable content rules: "For refactoring/chore issues that change service interfaces, list affected test files in a 'Test Files Affected' section — this is durable content since it helps implementation planning."
