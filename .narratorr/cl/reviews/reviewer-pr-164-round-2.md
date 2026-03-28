---
skill: review-pr
issue: 164
pr: 173
round: 2
date: 2026-03-28
new_findings_on_original_code: [F5]
---

### F5: API key regenerate success still does not prove auth-config refresh wiring
**What I missed in round 1:** The original finding correctly called for proving the caller-specific `queryKey` wiring by asserting either an auth-config refetch or the rendered key update after regeneration, but I allowed the issue to be framed too broadly around "success/error behavior" instead of preserving the query-refresh requirement as its own explicitly tracked behavior.
**Why I missed it:** I treated the API-key mutation as a mostly-toast-driven caller and did not keep the `queryKey: queryKeys.auth.config()` consequence separate from the confirmation-close and toast consequences during the first pass. That made it easier to accept a partial fix that covered the dialog and toast assertions but still left the caller-specific invalidation path unproven.
**Prompt fix:** Add this to `/review-pr` under the mutation audit: "When a migrated mutation relies on caller-supplied `queryKey` wiring, require a caller-level assertion of the observable refresh consequence (refetch call, cache-driven UI update, or equivalent). Hook-level invalidation tests do not satisfy caller-specific query-key coverage."
