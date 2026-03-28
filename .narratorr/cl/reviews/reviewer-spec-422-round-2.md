---
skill: review-spec
issue: 422
round: 2
date: 2026-03-17
new_findings_on_original_spec: [F1]
---

### F1: AC3 names a nonexistent `system.ts` consumer
**What I missed in round 1:** The spec says `system.ts` imports `searchAndGrabForBook` from `search-pipeline.ts` directly, but the current codebase shows `src/server/routes/system.ts` only imports `runSearchJob` and `searchAllWanted` from `src/server/jobs/search.ts`. No current consumer imports `searchAndGrabForBook` from `jobs/search.ts`, so that AC bullet is factually wrong.
**Why I missed it:** I verified that the stale re-exports exist and that `system.ts` depends on `jobs/search.ts`, but I did not separately verify the exact imported symbols named in the AC. I treated the cited consumer example as plausible instead of mechanically checking the import list.
**Prompt fix:** Add: "When the spec cites a caller file as evidence for a cleanup item, verify the exact imported symbol names in that file, not just that the file imports the module. Flag any AC bullet that names a nonexistent caller-symbol pair as blocking alignment."
