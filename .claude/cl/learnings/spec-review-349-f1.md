---
scope: [scope/services]
files: []
issue: 349
source: spec-review
date: 2026-03-15
---
Test plan included a case for `postProcessingScriptTimeout: 0` being preserved via nullish coalescing, but the settings schema (`processing.ts:18`) defines `z.number().int().min(1)` — the value 0 is rejected at the validation layer before it ever reaches the service. The `/elaborate` subagent read the service code but didn't cross-reference the schema that validates the setting upstream. Always check Zod schema constraints for any setting value before writing test cases that assume the value can reach runtime code.
