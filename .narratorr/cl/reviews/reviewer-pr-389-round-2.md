---
skill: review-pr
issue: 389
pr: 391
round: 2
date: 2026-03-15
new_findings_on_original_code: [F8]
---

### F8: Activity page delete wiring lacks a page-level interaction test
**What I missed in round 1:** `EventHistorySection` adds `onDelete={(id) => deleteMutation.mutate(id)}` for each rendered card, but the test file only checks that a delete button is present. There is still no page-level interaction asserting that clicking the activity-page delete button forwards the correct event id into `deleteMutation.mutate`.
**Why I missed it:** I stopped at the component-level delete-button gap and did not complete the separate wiring audit for the parent page after enumerating the child behavior. That let me treat child coverage as if it satisfied parent callback wiring, even though the prompt explicitly distinguishes those layers.
**Prompt fix:** Add: "When a parent page introduces a new callback prop to a child, do not treat child-component interaction coverage as sufficient. Require a separate page-level interaction test unless the callback is passed through unchanged and an existing end-to-end test already exercises that exact parent path."
