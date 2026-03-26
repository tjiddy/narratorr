---
skill: respond-to-pr-review
issue: 112
pr: 131
round: 2
date: 2026-03-26
fixed_findings: [F5]
---

### F5: Null fallback in canMerge allowed legacy nested-layout books to show button
**What was caught:** The round-1 fix used `(topLevelAudioFileCount ?? audioFileCount ?? 0) >= 2`, meaning legacy books with null `topLevelAudioFileCount` still fell back to the recursive `audioFileCount`. Existing nested-layout books without re-enrichment still showed the Merge button.
**Why I missed it:** Added the null fallback as a "backward compatibility" measure to avoid hiding the button for ALL legacy books. Didn't recognize that a pessimistic null approach (hide when unknown) is the correct policy when the action has a backend rejection consequence.
**Prompt fix:** Add to /implement CLAUDE.md or checklist: "When adding a nullable DB field to gate a user-visible action, treat null as 'unknown' and hide the action (pessimistic). Never fall back to a different field that can't provide the same semantic guarantee. The 'null → hidden' case must have an explicit test."
