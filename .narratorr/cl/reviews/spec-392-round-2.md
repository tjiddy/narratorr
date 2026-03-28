---
skill: respond-to-spec-review
issue: 392
round: 2
date: 2026-03-15
fixed_findings: [F5]
---

### F5: Direct inline settings mocks missed from migration surface
**What was caught:** AC4/AC5 verification grepped for `createMockSettings(` and `createMockSettingsService()` but missed 6+ server files that hardcode category defaults directly in inline `settingsService.get.mockResolvedValue({...})` calls without a wrapper helper.
**Why I missed it:** The previous round's fix focused on the two named patterns the reviewer had called out (factory callsites and wrapper helpers). I didn't step back to ask "are there other shapes of the same problem?" The grep in /elaborate searched for function names, not for the underlying pattern (any `mockResolvedValue` with a settings category literal object).
**Prompt fix:** Add to `/elaborate` step 3 (subagent prompt, item 12): "When identifying migration targets, enumerate ALL variant shapes of the pattern being replaced. For mock factories: search for (a) named factory function calls, (b) local wrapper/helper functions, AND (c) direct inline mock constructions (e.g., `vi.fn().mockResolvedValue({...})` with literal defaults). A pattern replacement spec is incomplete if it only covers the named variants."
