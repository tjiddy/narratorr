---
skill: respond-to-pr-review
issue: 66
pr: 72
round: 1
date: 2026-03-24
fixed_findings: [F1, F2]
---

### F1: GeneralSettingsForm not removed from General tab

**What was caught:** GeneralSettings.tsx still rendered `<GeneralSettingsForm />` after the refactor, duplicating Housekeeping/Logging on General when they should only be on System.

**Why I missed it:** The spec said "move GeneralSettingsForm to System" — I implemented the System side but missed removing it from General. The test also still asserted Housekeeping/Logging were present on the General tab, locking the regression in. Self-review checked that GeneralSettings.tsx had ProcessingSettingsSection removed (the main task) but didn't verify all unwanted sections were gone.

**Prompt fix:** Add to /implement self-review step: "For each component relocated from one page to another, verify BOTH that the destination renders it AND that the source explicitly does not. Check the source page file and its test for any assertions that would lock in stale composition."

### F2: createServices() bootstrap wiring untested

**What was caught:** The new `settings.bootstrapProcessingDefaults(detectFfmpegPath)` call in createServices() had no test — only the service method itself was unit tested. A future refactor could remove the call or pass the wrong function and nothing would catch it.

**Why I missed it:** The service method had 4 tests (including idempotency), so coverage felt complete. The wiring from createServices() to the service method is a separate integration point that requires its own test. The coverage review Explore subagent DID flag this as UNTESTED, but it was categorized among the 21 gaps rather than separated as a new-code gap.

**Prompt fix:** Add to /handoff coverage review guidance: "For every new call added to createServices() or other bootstrap/startup functions, require a direct test asserting the call happens with the correct argument — service-level tests are insufficient."
