---
skill: review-pr
issue: 341
pr: 347
round: 2
date: 2026-03-12
new_findings_on_original_code: [F13, F14, F15, F16, F17, F18, F19]
---

### F13: General form validation path still lacks direct regression coverage
**What I missed in round 1:** `GeneralSettingsForm.test.tsx` still does not assert that out-of-range retention values show inline validation and block `api.updateSettings`.
**Why I missed it:** The source bug dominated the first pass, and I stopped at the broken implementation without re-auditing the repaired test surface I had already called out informally in the code-review summary.
**Prompt fix:** After any source-level validation finding, add: "If the validation is later fixed in source, re-check the touched component test file for a direct invalid-submit assertion (`inline error` + `API not called`) before clearing the review round."

### F14: Library validation path still lacks direct regression coverage
**What I missed in round 1:** `LibrarySettingsSection.test.tsx` does not submit an empty/invalid path or template and assert the inline error plus no API call contract.
**Why I missed it:** I treated the missing resolver as sufficient evidence and did not convert the neighboring test gap into its own concrete finding.
**Prompt fix:** Add: "When a form renders `errors.*` branches for a newly changed section, require at least one invalid-submit test that would fail if the resolver were removed."

### F15: Search validation path still lacks direct regression coverage
**What I missed in round 1:** `SearchSettingsSection.test.tsx` never submits out-of-range search/RSS intervals or blacklist TTL values and never asserts `api.updateSettings` is skipped.
**Why I missed it:** I audited the payload and toast mutations, but I did not re-scan the suite for the mirrored negative-path assertion contract after identifying the missing source validation.
**Prompt fix:** Add: "For each numeric field with min/max constraints added or moved in a PR, require one invalid boundary test in the same component suite."

### F16: Import validation path still lacks direct regression coverage
**What I missed in round 1:** `ImportSettingsSection.test.tsx` does not verify that negative numeric inputs surface an error and block submit.
**Why I missed it:** The refactor touched many nearly identical section suites, and I did not systematically apply the same invalid-submit audit to each one after finding the pattern once.
**Prompt fix:** Add: "Do not stop at the first repeated form-validation regression; audit every touched section suite for the same invalid-submit contract and list the missing ones explicitly."

### F17: Quality validation path still lacks direct regression coverage
**What I missed in round 1:** `QualitySettingsSection.test.tsx` has no invalid-submit assertion for negative `grabFloor` or `minSeeders`.
**Why I missed it:** I focused on the source-side resolver removal and let the repeated component-test gap ride as an implicit consequence instead of a separate finding.
**Prompt fix:** Add: "Whenever a settings section adds `zodResolver`, demand a matching test that proves the resolver gates submit rather than only decorating field props."

### F18: Network invalid-URL validation still lacks direct regression coverage
**What I missed in round 1:** `NetworkSettingsSection.test.tsx` still does not cover the invalid URL case that the source now validates.
**Why I missed it:** I focused on the sentinel scenario and proxy test flows, and I failed to enumerate the newly added invalid-URL submit path as its own component-level behavior.
**Prompt fix:** Add: "For URL fields, require both normalization/acceptance coverage and one invalid-format rejection test with `api.updateSettings` not called."

### F19: Processing ffmpeg-required validation still lacks direct regression coverage
**What I missed in round 1:** `ProcessingSettingsSection.test.tsx` does not submit `processingEnabled=true` with an empty `ffmpegPath` and assert the inline error/no-API-call contract.
**Why I missed it:** I treated the spec's explicit ffmpeg validation case as satisfied by the source finding and did not preserve it as a standalone test requirement after the implementation changed.
**Prompt fix:** Add: "If the issue spec names a concrete invalid-submit scenario, that scenario must appear as a dedicated test finding unless a direct assertion already exists in the changed suite."
