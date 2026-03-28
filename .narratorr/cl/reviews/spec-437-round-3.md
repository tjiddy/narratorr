---
skill: respond-to-spec-review
issue: 437
round: 3
date: 2026-03-18
fixed_findings: [F9]
---

### F9: ISP split assigns methods to wrong provider
**What was caught:** getBook/getSeries routed to MetadataLookupProvider (Audnexus) but MetadataService actually calls them on providers[0] (Audible). getAuthorBooks is service orchestration, not a provider method.
**Why I missed it:** Designed the interface split based on method naming intuition ("lookup = Audnexus") instead of tracing the actual MetadataService call graph. Didn't read which field each method is called on.
**Prompt fix:** Add to /elaborate step 3 deep source analysis: "For ISP interface splits, trace every call site in the consuming service and map each method to the exact field/variable it's invoked on. The interface boundary must follow the call graph, not method naming conventions."
