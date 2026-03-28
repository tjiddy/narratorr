---
skill: respond-to-spec-review
issue: 198
round: 1
date: 2026-03-12
fixed_findings: [F1, F2, F3, F4, F5, F6]
---

### F1: Semaphore/concurrency and entry points unspecified
**What was caught:** Spec claimed scripts run "outside the processing semaphore" without defining the execution model or listing entry points.
**Why I missed it:** `/elaborate` accepted the scope boundary "scripts run outside the processing semaphore" at face value without verifying the semaphore lifecycle in `import.service.ts`. The semaphore wraps the entire `importDownload()` call, so there's no way to run a phase "outside" without a detached runner.
**Prompt fix:** Add to `/elaborate` step 3 codebase exploration: "For specs adding new phases to an existing pipeline, verify the concurrency/synchronization model — identify where locks/semaphores are acquired and released, and confirm whether the spec's concurrency claims are achievable without new infrastructure."

### F2: Vague pipeline placement
**What was caught:** "After import + conversion" doesn't place the hook precisely in a 10+ phase pipeline.
**Why I missed it:** `/elaborate` explored the import pipeline but didn't require the spec to name exact phase ordering. The AC said "after successful import/processing" which felt sufficient but is ambiguous in a pipeline with multiple post-processing stages.
**Prompt fix:** Add to `/elaborate` step 4 gap-fill: "For specs adding phases to an existing sequential pipeline (import, job processing), require AC to specify exact placement relative to adjacent phases. Vague placement like 'after X' is insufficient when 5+ phases follow X."

### F3: Timeout field UI/persistence contract
**What was caught:** "Optional number, default 300" doesn't account for `stripDefaults()`, `valueAsNumber: true` NaN behavior, or `settingsToFormData()` merge.
**Why I missed it:** `/elaborate` added the timeout field but didn't check how existing numeric fields (bitrate, maxConcurrentProcessing) handle the same lifecycle. The settings form architecture has a non-obvious default-stripping pattern that makes "optional with default" insufficient.
**Prompt fix:** Add to `/elaborate` step 3 deep source analysis: "For new settings fields, read the settings form schema derivation (`stripDefaults`, `settingsToFormData`) and check how existing fields of the same type handle empty/clear/default behavior. Spec must define the full round-trip contract."

### F4: Env var namespace inconsistency
**What was caught:** Spec used `NARRATORR_TITLE` when existing script integration uses `NARRATORR_BOOK_TITLE`.
**Why I missed it:** `/elaborate` didn't check existing env var conventions in the script notifier. The original spec said "etc." which I should have flagged as untestable.
**Prompt fix:** Add to `/elaborate` step 2 parse spec completeness: "Flag 'etc.' or equivalent vagueness in any AC that defines an external contract (env vars, API fields, CLI args, file formats). These must be exhaustively enumerated to be testable."

### F5: Test fixture blast radius not listed
**What was caught:** Didn't list specific test files with hardcoded processing settings that would break.
**Why I missed it:** The explore subagent identified the blast radius but I only mentioned it generically in the test plan instead of listing specific files.
**Prompt fix:** Add to `/elaborate` step 4 test plan gap-fill: "For schema changes, include a 'fixture blast radius' section listing specific test files that hardcode the affected schema shape."

### F6: Open PR overlap not noted
**What was caught:** PR #347 touches the same settings UI surface.
**Why I missed it:** The explore subagent checked for overlapping PRs but I didn't propagate the finding into the spec body.
**Prompt fix:** Add to `/elaborate` step 4 gap-fill: "If the explore subagent finds overlapping open PRs, add a note to the Technical Notes section naming the PR and the shared surface area."
