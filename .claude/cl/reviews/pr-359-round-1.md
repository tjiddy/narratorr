---
skill: respond-to-pr-review
issue: 359
pr: 378
round: 1
date: 2026-03-15
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: processRestoreUpload service-level coverage missing
**What was caught:** Route tests mock the new service method, so the extracted zip/validation logic has no real test coverage.
**Why I missed it:** Focused on updating existing route tests to mock the new method without realizing the extracted logic itself lost coverage.
**Prompt fix:** Add to `/implement` step 4a (Red — write failing tests): "When extracting logic from a route handler to a service method, add service-level tests for the extracted method. Route tests that now mock the service only test delegation, not the implementation."

### F2: createRetrySearchDeps factory untested
**What was caught:** New factory function used by two call sites has no direct test.
**Why I missed it:** Treated the factory as trivial mapping code that "can't be wrong." But a swapped field would compile and silently misroute.
**Prompt fix:** Add to `/implement` step 4d (sibling enumeration): "Every new factory/builder function that maps fields must have a by-reference test — even if the mapping looks trivial."

### F3: Validation error format not pinned down
**What was caught:** Prowlarr tests only assert 400 status, not the response body format.
**Why I missed it:** Fastify validation errors are handled by the error handler plugin now, but I only tested status codes in the route tests.
**Prompt fix:** Add to `/implement` M-11 error handler checklist: "When migrating routes from manual validation to schema-based, update route tests to assert the new response body format (statusCode/error/message)."

### F4: Error handler logging not asserted
**What was caught:** The error handler's `request.log.error` and `request.log.warn` calls have no assertions.
**Why I missed it:** Testing logging side effects requires injecting a spyable logger, which I didn't set up.
**Prompt fix:** Add to error-handler test pattern: "For any new error handler or middleware that logs, create a dedicated test suite with a spyable logger injected via onRequest hook."

### F5: Invalid ID schema swap not exercised
**What was caught:** The shared idParamSchema has different validation rules than the old local schema.
**Why I missed it:** Assumed behavioral equivalence without reading both schemas' actual validation logic.
**Prompt fix:** Add to `/implement` step 4d: "When replacing a local schema with a shared one, compare both schemas' validation rules field by field. Add tests for the boundary cases (zero, negative, NaN)."
