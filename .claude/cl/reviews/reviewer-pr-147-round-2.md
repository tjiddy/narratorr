---
skill: review-pr
issue: 147
pr: 156
round: 2
date: 2026-03-27
new_findings_on_original_code: [F6, F7, F8, F9]
---

### F6: useFetchCategories non-Error fallback untested
**What I missed in round 1:** `useFetchCategories()` now maps non-`Error` rejections to `'Failed to fetch categories'`, but the component coverage only proves the `Error('Network error')` branch.
**Why I missed it:** I audited the five unsafe-cast sites explicitly called out in the first pass and did not expand the same non-`Error` fallback check to the other frontend catch sites that changed behavior in the original diff.
**Prompt fix:** Add to `/review-pr`: "After clearing any initial fallback test gaps, scan every changed `catch` converted to `error instanceof Error ? ... : <fallback>` and require one direct test per fallback string, even when the spec only listed a subset of those files."

### F7: useMatchJob start failure non-Error fallback untested
**What I missed in round 1:** The `startMatchJob` catch now produces `'Unknown error'` for non-`Error` throws, but tests only cover `new Error('Network error')`.
**Why I missed it:** I treated `useMatchJob` as another mechanical rename because the surrounding hook tests were already broad, and I did not split the startup catch from the polling catch into separate independently-breakable behaviors.
**Prompt fix:** Add to `/review-pr`: "For hooks with multiple changed catch blocks, enumerate each catch site separately in Behavior Coverage. Startup failure and polling failure are distinct behaviors and need distinct test evidence."

### F8: useMatchJob poll failure non-Error fallback untested
**What I missed in round 1:** The polling catch also gained `'Unknown error'` fallback behavior for non-`Error` rejections, but existing tests only prove the `Error('Job expired')` branch.
**Why I missed it:** Once I saw one poll-failure test, I incorrectly treated the catch as covered instead of applying the deletion heuristic to the new fallback branch itself.
**Prompt fix:** Add to `/review-pr`: "When a catch block changes from `err.message` to `instanceof Error ? err.message : fallback`, a test that only uses `new Error(...)` does not cover the fallback branch. Require explicit non-`Error` rejection evidence."

### F9: ProcessingSettingsSection ffmpeg probe fallback untested
**What I missed in round 1:** The ffmpeg probe handler now falls back to `'ffmpeg probe failed'` for non-`Error` rejections, but the component tests only assert the `spawn ENOENT` message path.
**Why I missed it:** I focused on the service and utility fallbacks because those were already disputed in round one, and I under-reviewed the remaining frontend catch sites that also changed visible behavior.
**Prompt fix:** Add to `/review-pr`: "For frontend catch fallbacks, require assertions for every user-visible consequence the fallback drives (toast text, inline feedback, disabled/reset state), not just the error-typed path."
