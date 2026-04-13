---
scope: [frontend]
files: [src/client/hooks/useEventHistory.ts]
issue: 537
source: review
date: 2026-04-13
---
The retry endpoint returns a union type (Download | { status: 'no_candidates' } | { status: 'retry_error' }), but the new retryMutation.onSuccess handler treated all resolved responses as success. When reusing an existing API method in a new mutation, always read the API contract and response type to handle all branches — resolved-but-not-success is a common pattern in this codebase.
