---
skill: respond-to-pr-review
issue: 85
pr: 88
round: 1
date: 2026-03-25
fixed_findings: [F1]
---

### F1: Comma-in-name author round-trip test missing restore half

**What was caught:** The spec AC said "round-trip test" but only the moveToRecycleBin() (snapshot) half was added. The restore() half — asserting syncAuthors receives the comma-containing name intact — was missing.

**Why I missed it:** The spec test plan listed these separately:
- "moveToRecycleBin() with author name containing a comma → stored as ['Jordan, Robert']"
- (implicitly: restore passes it intact)

During implementation I read the narrator comma-in-name test (`Smith, John`) which only covers `moveToRecycleBin()`, treated it as the model, and added the author version in the same `describe` block — missing that the RESTORE path also needed a comma-name test. The existing restore tests at `:565-600` use names without commas, so they don't catch a hypothetical split-on-comma regression.

**Prompt fix:** Add to `/implement` step 4a: "When an AC says 'round-trip', verify tests exist for BOTH the write/store direction AND the read/restore direction. A round-trip AC is never satisfied by a single-direction test." Also add to test plan checklist: "For round-trip behaviors, enumerate: (1) storage assertion, (2) retrieval/restore assertion — both are required."
