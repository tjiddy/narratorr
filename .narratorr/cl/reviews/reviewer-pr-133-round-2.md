---
skill: review-pr
issue: 133
pr: 136
round: 2
date: 2026-03-26
new_findings_on_original_code: [F1]
---

### F1: Hook test for no-match deselection is vacuous
**What I missed in round 1:** The added `useLibraryImport` test named `match results merge: no-match rows auto-deselected, duplicate rows stay unselected` never actually drives a no-match result through the hook; it only checks initial selection state, so the claimed behavior remained unproven.
**Why I missed it:** I focused on the larger runtime mismatches in the new page/hook flow and accepted the test title/comment as evidence instead of applying the deletion heuristic to the assertion body.
**Prompt fix:** Add explicit guidance to re-review and first-round review alike: "When a test claims to simulate an async state change, verify the mock/event causing that transition actually occurs. Comments are not coverage. For every behavior marked verified, ask whether deleting the target branch or state-transition line would make the cited test fail."
