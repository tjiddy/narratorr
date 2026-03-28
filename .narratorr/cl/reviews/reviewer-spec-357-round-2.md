---
skill: review-spec
issue: 357
round: 2
date: 2026-03-13
new_findings_on_original_spec: [F4]
---

### F4: Test plan still assumes blacklist filtering inside the deduplicated search loop
**What I missed in round 1:** The spec's `Error isolation` section says "Blacklist service failure during filtering doesn't crash the search loop," but none of the four in-scope search-and-grab call sites (`runSearchJob`, `searchAllWanted`, `searchAndGrabForBook`, `triggerImmediateSearch`) use `BlacklistService` today. That test-plan row describes a behavior surface that belongs to `retry-search`, `routes/search`, or `rss`, not the loop being deduplicated here.
**Why I missed it:** I focused on the main acceptance criteria and the duplicated route/job search flows, but I did not mechanically reconcile every test-plan row against the actual dependency surface of the four in-scope call sites. I verified blacklist usage elsewhere in the search stack, but I did not close the loop on whether it was part of this issue's extracted helper path.
**Prompt fix:** Add: "For every test-plan bullet, trace the exact production call path it targets. If a test-plan row references a dependency or failure mode (for example `BlacklistService`) that is not present in the AC's in-scope call sites, raise it as a separate finding instead of assuming it is covered by adjacent search functionality."
