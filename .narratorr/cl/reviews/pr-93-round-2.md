---
skill: respond-to-pr-review
issue: 93
pr: 107
round: 2
date: 2026-03-25
fixed_findings: [F1, F2]
---

### F1: ActivityPage clamp tests at hook level instead of page level
**What was caught:** Tests used `renderHook(() => usePagination(50))` to test `clampToTotal` in isolation instead of mounting `ActivityPage` and exercising the `useEffect` wiring.

**Why I missed it:** During implementation, I tried page-level tests first but hit a TanStack Query race condition (key change → data undefined → total=0 → clamp fires → page resets). I concluded page-level tests were "impossible" and fell back to hook tests. I didn't recognize that the race condition was a production bug requiring a fix (`placeholderData`), not a test design limitation to work around.

**Prompt fix:** Add to `/plan` step on testing paginated queries: "All paginated `useQuery` calls that pair with a `clampToTotal` `useEffect` need `placeholderData: (prev) => prev` to prevent mid-navigation total flicker. Without it, page navigation is broken in production AND page-level clamp tests are impossible. If you find yourself falling back to hook-level tests because 'page-level navigation doesn't work', that IS the bug — fix the production code first."

### F2: fileFormat validation test doesn't prove submit-time error path
**What was caught:** The assertion `expect(getAllByText(/Template must include/).length).toBeGreaterThanOrEqual(1)` passes before submit because the watch-based warning is already visible.

**Why I missed it:** I saw the test pass and assumed it was correct. I didn't reason through whether the assertion would pass even if the submit-time `errors.fileFormat` render path was deleted.

**Prompt fix:** Add to `/implement` testing guidelines: "When testing form validation with `zodResolver`, always add a pre-submit baseline count for any validation messages. If the same text appears as both a watch-based warning and a resolver error, the post-submit count must increase by 1. `toBeGreaterThanOrEqual(1)` is never sufficient for proving a submit path fired — use `.toBe(2)` or scope the assertion specifically to the error element."
