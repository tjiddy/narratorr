---
skill: respond-to-spec-review
issue: 432
round: 3
date: 2026-03-17
fixed_findings: [F1]
---

### F1: Barrel file path pointed at nonexistent `src/shared/schemas/index.ts`
**What was caught:** The AC and test plan referenced `src/shared/schemas/index.ts` as the export surface, but the repo uses `src/shared/schemas.ts` (flat barrel, no directory).
**Why I missed it:** In round 1, I rewrote the enrichmentStatus AC to be more specific about consumer surfaces but copy-pasted a conventional `index.ts` barrel path instead of verifying the actual filename. The "verify fixes before writing" step (step 6) should have caught this — I verified the schema target file (`book.ts`) but not the barrel re-export path.
**Prompt fix:** Add to `/respond-to-spec-review` step 6: "For every file path mentioned in the updated AC or test plan, run `ls` or `test -f` to confirm the file exists. This includes barrel/index files, not just primary targets."
