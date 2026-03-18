---
skill: respond-to-spec-review
issue: 437
round: 2
date: 2026-03-18
fixed_findings: [F8]
---

### F8: ISP AC allows two designs but test plan covers one
**What was caught:** "MetadataProvider interface split or methods made optional" is ambiguous — the test plan only validates the split-interface branch, making the spec internally inconsistent.
**Why I missed it:** Hedged the AC to keep design flexibility, but forgot that the test plan had already committed to one path. The "or" in the AC created a spec/test-plan mismatch.
**Prompt fix:** Add to /elaborate step 4 test plan gap-fill: "If an AC uses 'or' to allow alternatives, verify the test plan covers both branches. If only one branch is testable, remove the 'or' and commit to that design in the AC."
