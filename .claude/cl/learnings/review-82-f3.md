---
scope: [scope/backend, scope/services]
files: [src/server/services/auth.service.test.ts]
issue: 82
source: review
date: 2026-03-25
---
`expect(spy).toHaveBeenCalled()` proves nothing about what arguments the spy received. For security-critical comparators like `timingSafeEqual`, the test must assert both the buffer arguments and cover both the success and failure paths.

**Why I missed it:** I added the wrong-password path with `toHaveBeenCalled()` but didn't think to verify the actual buffer values or test the success path, where the buffers match and the comparator returns true.

**What would have prevented it:** Any spy assertion on a security function should use `toHaveBeenCalledWith(...)` with argument matchers. For cryptographic comparators, cover both success path (buffers match, result truthy) and failure path (buffers differ, result falsy). The spec's test plan referenced both paths — read each test-plan item as a required assertion, not just a required test.
