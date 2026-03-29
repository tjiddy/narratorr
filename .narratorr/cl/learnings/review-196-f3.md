---
scope: [backend]
files: [src/server/services/discovery.service.test.ts]
issue: 196
source: review
date: 2026-03-29
---
When adding integration tests for a pipeline, assert ALL output fields that the changed code path touches — not just the primary behavioral fields (score, reason). The reason-text formatting branch was changed but no test asserted `reasonContext`, meaning the ternary could be inverted without failing the suite. Every changed conditional should map to at least one assertion that would fail if the condition were removed or inverted.
