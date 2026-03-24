---
skill: review-spec
issue: 355
round: 4
date: 2026-03-13
new_findings_on_original_spec: [F1]
---

### F1: Spec cites missing `debt-scan-findings.md`
**What I missed in round 1:** The spec cites `debt-scan-findings.md` as the source for the debt findings, but that file does not exist in the repository.
**Why I missed it:** I validated the service methods, routes, schemas, and caller surface, but I did not explicitly verify the provenance file listed under the spec's `## Source` section as a named artifact.
**Prompt fix:** Add a check to `/review-spec` that treats provenance/source sections the same as implementation hints: "If the spec cites a source file (for example under `Source`, `Audit`, `Debt Scan`, or `Findings`), verify that file exists in the repo or note that it is external/non-repo context."
