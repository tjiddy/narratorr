---
skill: respond-to-spec-review
issue: 355
round: 1
date: 2026-03-13
fixed_findings: [F1, F2, F3, F4]
---

### F1: Default limit silently truncates frontend data
**What was caught:** Frontend pages derive counts, filters, and aggregations from full datasets. A default limit=50 would hide data without pagination UI.
**Why I missed it:** Focused on the backend query optimization without reading the frontend consumers to understand how they use the data. The elaboration step explored frontend touch points but didn't analyze the client-side filtering/counting patterns deeply enough.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "For each route being modified, READ the frontend component that consumes it. Identify any client-side filtering, counting, aggregation, or derived state that depends on the full dataset. If the spec adds server-side limits, verify the frontend can still function correctly with truncated data."

### F2: BookService.getAll() has internal callers beyond the route
**What was caught:** Search jobs, RSS sync, and rename service all call `BookService.getAll()` and need the full unpaginated dataset.
**Why I missed it:** The elaboration step's codebase exploration didn't trace callers of the service methods being modified. It found the service files but didn't grep for all call sites.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "For each service method being modified, use grep to find ALL callers (not just the route handler). If non-route callers exist, note whether they need the full dataset or can work with pagination. Flag any shared method where adding a default limit would break internal callers."

### F3: Blacklist not explicitly covered in AC and test plan
**What was caught:** Blacklist was implicitly included in "all four routes" but had no explicit AC item, test case, or client contract mention.
**Why I missed it:** Used collective language ("all four") instead of enumerating each service individually in AC and test plan. The blacklist got lumped in but never specifically validated.
**Prompt fix:** Add to `/elaborate` step 4 gap-fill: "When AC references a group ('all N services'), ensure every member is explicitly named in at least one AC item and has dedicated test plan entries. Groups hide omissions."

### F4: Blacklist uses different timestamp column and has no existing sort
**What was caught:** AC5 assumed all services sort by `createdAt`/`addedAt`, but blacklist uses `blacklistedAt` and had no orderBy.
**Why I missed it:** Didn't read the actual schema or service source for blacklist — assumed it followed the same pattern as the other three.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt under deep source analysis: "For each service method, verify the actual column names used for sorting against the DB schema. Don't assume conventions are uniform across tables."
