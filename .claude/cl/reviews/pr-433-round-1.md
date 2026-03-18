---
skill: respond-to-pr-review
issue: 433
pr: 442
round: 1
date: 2026-03-17
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: ProcessingSettingsSection FormField migration incomplete
**What was caught:** ProcessingSettingsSection was named as a first-wave adoption target but only had label constants moved — the repeated border/error input pattern wasn't converted to FormField.
**Why I missed it:** The /plan step enumerated the three existing consumer files (DownloadClientForm, IndexerCard, NotifierCardForm) as adoption targets and treated ProcessingSettingsSection as scope for label constant extraction only. Didn't cross-reference the spec's full first-wave file list against the FormField adoption checklist.
**Prompt fix:** Add to /implement: "When a spec names files as adoption targets for a new component, verify each named file is fully converted. Check every instance of the pattern being replaced — don't rely on the plan's file list being exhaustive."

### F2: CrudSettingsPage headerExtra untested
**What was caught:** The new `headerExtra` optional prop had a rendering branch with zero test coverage.
**Why I missed it:** Tests focused on the DownloadClientsSettings integration (the first consumer) which doesn't use headerExtra. Didn't notice the component's own interface had an untested branch.
**Prompt fix:** Add to /plan test stub generation: "For extracted generic components with optional props, generate one test stub per optional rendering branch — even if no current consumer exercises it. Uncovered optional branches are dead code waiting to happen."

### F3: MetadataService transient tests missing log.warn assertions
**What was caught:** Transient-contract tests asserted fallback return values but not the log.warn calls.
**Why I missed it:** Focused on proving the new TransientError type didn't change return values. Didn't treat logging as part of the observable contract.
**Prompt fix:** Add to testing.md: "When a catch block has multiple side effects (return value + logging + state change), assert all of them. Logging assertions are especially important for error classification changes where the log message is the only observable difference between error types."

### F4: Audible getBook() missing timeout/network tests
**What was caught:** getBook() had 5xx and 404 tests but not timeout or network error tests.
**Why I missed it:** Assumed the shared request helper's coverage (via searchBooks) was sufficient.
**Prompt fix:** Add to /implement: "When adding error classification tests for adapters, use the first fully-tested method as a template. Every changed entry point must have the same error category coverage (timeout, network, 5xx, 404/not-found)."

### F5: Audnexus getAuthor() missing timeout/network tests
**What was caught:** Same gap as F4 on a different provider.
**Why I missed it:** Same root cause as F4.
**Prompt fix:** Same as F4 — the template principle applies across providers.
