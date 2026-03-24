---
skill: respond-to-pr-review
issue: 57
pr: 61
round: 4
date: 2026-03-24
fixed_findings: [F1, F2]
---

### F1: 409 retry confirmation path drops indexerId

**What was caught:** `PendingGrabParams` didn't include `indexerId`, so the `setPendingReplace()` call in the 409 error handler silently dropped it. The confirm-modal retry then spread the incomplete object, losing the indexer identity for replacement grabs.

**Why I missed it:** When implementing the replacement-confirmation flow, I checked that the initial grab forwarded `indexerId` but didn't audit the intermediate `PendingGrabParams` type to ensure it included all fields. I treated the interface as defining "what the confirm needs" rather than "the full payload preserved for retry."

**Prompt fix:** Add to `/implement` step for error-retry/confirmation flows: "When storing params for a later retry (e.g. confirmation modal), verify that the intermediate state type mirrors the *complete* original call payload — every field sent on the initial call must appear in the intermediate type. Check the original call site's arguments list, then diff it against the intermediate interface fields."

### F2: Replacement confirmation test didn't cover indexerId

**What was caught:** The test for the 409→confirm→retry flow only checked `replaceExisting: true` and a few other fields, not `indexerId`. This meant F1 could have existed (and did) without the test catching it.

**Why I missed it:** When writing the test for the confirmation flow, I focused on what makes the retry *different* from the initial grab (`replaceExisting`) rather than asserting the full payload contract. Any field new to the feature (like `indexerId`) should be asserted at every call site.

**Prompt fix:** Add to `/implement` testing standards: "For confirmation-retry and error-retry tests, assert the full grab/mutation payload including any new fields added in this feature — not just the field that distinguishes the retry from the initial call. If the feature adds field X, every test that checks a grab call must include `expect.objectContaining({ X: expectedValue })`."
