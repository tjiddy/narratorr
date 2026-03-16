---
scope: [backend, services]
files: [src/server/jobs/search.ts, src/server/services/search-pipeline.ts]
issue: 357
source: review
date: 2026-03-13
---
Reviewer caught that extracting a function that throws on error changes counter semantics for callers that increment between two sequential operations (search, then grab). When `searchAndGrabForBook` threw on grab errors, callers couldn't distinguish "search failed" from "grab failed after successful search", breaking the `searched` counter contract. Fix: return error results instead of throwing, so callers can always increment `searched` on successful search. This is the same issue identified during implementation but was incorrectly resolved by updating the test instead of fixing the code.
