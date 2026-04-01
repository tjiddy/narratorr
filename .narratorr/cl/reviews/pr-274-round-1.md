---
skill: respond-to-pr-review
issue: 274
pr: 279
round: 1
date: 2026-04-01
fixed_findings: [F1, F2, F3]
---

### F1: DB reset before file deletion (DB-1)
**What was caught:** File deletion happened before DB update — crash between the two would leave stale DB state.
**Why I missed it:** I placed file deletion logically before DB reset as part of "cleanup," without verifying against the DB-1 ordering rule.
**Prompt fix:** Add to `/implement` step 4b: "After writing service methods with both DB writes and FS operations, verify DB-1: does any irreversible FS op (rm, rename, unlink) execute before the DB write that records its consequence? If so, swap the order."

### F2: String-based error routing (ERR-1)
**What was caught:** Route used `error.message.includes(...)` to derive HTTP status codes instead of the typed error registry pattern.
**Why I missed it:** The Explore phase didn't discover `src/server/plugins/error-handler.ts` and its `ERROR_REGISTRY` pattern. I wrote the route with inline try/catch.
**Prompt fix:** Add to `/plan` step 3 Explore prompt: "When the plan adds a new route with error handling, grep for `ERROR_REGISTRY` or `setErrorHandler` in `src/server/plugins/` to discover the centralized error mapping pattern. If found, note it in WIRING POINTS."

### F3: Missing query invalidation test
**What was caught:** The `wrongReleaseMutation` success test didn't assert `invalidateQueries` calls — only toast and API call.
**Why I missed it:** Didn't replicate the existing sibling pattern (merge, rename, monitor mutations all have dedicated invalidation spy tests).
**Prompt fix:** Add to testing standards: "When adding a new mutation to an existing hook file, check sibling mutations for their test patterns (invalidation spies, error recovery, pending state). Every pattern present on siblings must be present on the new mutation."
