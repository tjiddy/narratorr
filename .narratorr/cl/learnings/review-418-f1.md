---
scope: [scope/services]
files: [src/shared/schemas/settings/discovery.ts, src/shared/schemas/settings/discovery.test.ts]
issue: 418
source: review
date: 2026-03-17
---
Reviewer caught that the dynamically-generated `weightMultipliersSchema` (built from `SUGGESTION_REASONS` via `Object.fromEntries`) had no test covering caller-provided values or strip-unknown behavior. Existing tests only covered defaults/omission. A broken `fromEntries` shape or accidental `.strict()` addition would have passed all tests.

Root cause: When refactoring a schema from static to dynamic derivation, we tested the default path but not the explicit-input path. The test gap was a failure to treat the derivation mechanism itself as a new behavior requiring its own test — we assumed existing default-coverage was sufficient.

Prevention: When converting static schema definitions to dynamically-derived ones, always add a test that exercises the schema with explicit caller-provided values (including unknown keys) to verify both the generated shape and strip/strict behavior.
