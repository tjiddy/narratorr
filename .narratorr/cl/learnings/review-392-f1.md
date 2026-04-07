---
scope: [backend, frontend]
files: [src/server/services/search-pipeline.ts, src/shared/schemas/sse-events.ts, src/client/pages/activity/SearchCard.tsx]
issue: 392
source: review
date: 2026-04-07
---
The spec said to collapse `skipped` and `grab_error` into `no_results` for SSE outcomes, reasoning "user doesn't need to know." The reviewer correctly identified this creates a misleading UX: "No results found" is shown even when results were found and the grab itself failed. The spec's intent (simplify user-facing state) was wrong — users seeing "No results found" when results existed is a factual misstatement. Preserve terminal state distinctions even when the user-facing copy is simplified. The gap was in the spec's outcome mapping AC, which should have been challenged during elaboration.
