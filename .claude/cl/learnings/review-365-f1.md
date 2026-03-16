---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.tsx, src/client/components/SearchReleasesModal.test.tsx]
issue: 365
source: review
date: 2026-03-15
---
When tightening an API contract (making a field required), the success-path test for all callers must assert the new required field is passed correctly. The existing test only covered disabled/error paths for blacklisting — no test verified the happy path payload, which is where the contract change actually matters. TanStack Query `mutationFn` gets called with (data, mutationContext), so assertions need `expect.anything()` for the second arg.
