---
skill: respond-to-pr-review
issue: 392
pr: 399
round: 3
date: 2026-03-15
fixed_findings: [F4]
---

### F4: import.service.test.ts still has 5 inline settings mocks
**What was caught:** Five `inject<SettingsService>({...})` calls in tagging integration tests and post-processing script tests still hardcoded full category literal objects.
**Why I missed it:** The earlier migration of import.service.test.ts only replaced the top-level `createMockSettingsService()` wrapper and the `.get` override callsites. The file has 2000+ lines and additional inline settings constructions were added later in the tagging/script sections using `inject<SettingsService>` instead of the local wrapper. My grep only searched for `createMockSettingsService` and `settingsService.get.mockResolvedValue`, missing the `inject<SettingsService>` pattern.
**Prompt fix:** Add to `/implement` step 4d: "For large test files (>500 lines), after migrating known patterns, also grep the entire file for the TYPE being mocked (e.g., `SettingsService`) to find alternative construction patterns that bypass the named wrapper."
