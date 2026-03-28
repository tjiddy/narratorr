---
skill: respond-to-spec-review
issue: 352
round: 1
date: 2026-03-14
fixed_findings: [F1, F2, F3, F4]
---

### F1: AC2 unconditional test-depth requirement conflicts with repo standard
**What was caught:** AC2 required 3 tests per AC item unconditionally, but `.claude/docs/testing.md` says categories apply "where applicable."
**Why I missed it:** The /elaborate skill generated AC from the findings without cross-referencing the existing testing contract in `.claude/docs/testing.md`.
**Prompt fix:** Add to `/elaborate` step 4 (Fill gaps): "Before writing new testing requirements in AC, verify they are consistent with `.claude/docs/testing.md` — especially the 'where applicable' standard. New AC must not contradict established repo conventions."

### F2: AC4 undefined rerun behavior for manual review findings
**What was caught:** "Re-run the same check" is meaningless when the original finding was a prose observation, not a command.
**Why I missed it:** Assumed all review findings map to runnable checks. Didn't think through the manual-review case.
**Prompt fix:** Add to `/elaborate` step 2 (Parse spec completeness): "For AC items that reference automated verification, confirm the verification mechanism exists. For AC items that reference 'rerun' or 'recheck,' define the fallback for cases where no automated check exists."

### F3: AC5 references nonexistent validation infrastructure
**What was caught:** "Parse correctly" implies a parser that doesn't exist. `/verify` doesn't cover skill files.
**Why I missed it:** Wrote the AC assuming validation infrastructure exists without checking.
**Prompt fix:** Add to `/elaborate` step 3 (Explore codebase): "Verify that any validation, linting, or checking tools referenced in AC actually exist in the repo. If an AC depends on running a tool, confirm the tool is present."

### F4: Source citation references non-repo artifact
**What was caught:** `debt-scan-findings.md` is not in the repo, so readers can't find it.
**Why I missed it:** Carried over the source reference from the original issue creation context without checking whether it was a committed file.
**Prompt fix:** Add to `/elaborate` step 4 (Fill gaps): "When preserving or adding source citations, verify the cited file exists in the repo (`git ls-files`). If it's external, say so explicitly."
