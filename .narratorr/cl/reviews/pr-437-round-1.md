---
skill: respond-to-pr-review
issue: 437
pr: 447
round: 1
date: 2026-03-18
fixed_findings: [F1, F2, F3]
---

### F1: Zero-search-provider path untested
**What was caught:** The empty-registry case (no search providers) had no service-level test coverage.
**Why I missed it:** The old code always hardcoded AudibleProvider, so the `!provider` guard was unreachable. The refactor to registry made it reachable, but I didn't think to test the new empty-registry mode because I was focused on the normal path.
**Prompt fix:** Add to /implement step 4a: "When a refactor changes how a collection is populated (hardcoded → registry/config-driven), add a test for the empty-collection case in the same module — it's now a real supported mode, not a theoretical guard."

### F2: Factory config forwarding untested
**What was caught:** MetadataService constructor passes config to factory, but no test asserted the exact arguments.
**Why I missed it:** The registry test proved the factory works, but I didn't test the wiring from MetadataService to the factory. Treated the two layers as independently tested when the integration point was the critical new behavior.
**Prompt fix:** Add to /implement step 4a: "When introducing indirection (service → registry → factory), test the argument forwarding at the service level, not just the factory in isolation. The wiring IS the new behavior."

### F3: Probe delegation methods untested
**What was caught:** New public methods on HealthCheckService had no direct service-level tests.
**Why I missed it:** Route tests mocked the service methods, so they seemed covered. But mocking means the real delegation inside the service was never exercised.
**Prompt fix:** Add to /implement step 4a: "When adding a new public method that delegates to an injected dep, write a service-level test asserting exact argument forwarding and error propagation. Route-level mocks don't exercise the delegation."
