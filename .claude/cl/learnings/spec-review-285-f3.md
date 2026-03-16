---
scope: [scope/backend, scope/services]
files: [src/server/services/match-job.service.ts, src/server/services/library-scan.service.ts]
issue: 285
source: spec-review
date: 2026-03-11
---
Spec said "match against Audible metadata for enrichment" without specifying matching policy. The codebase has two different matching patterns (library-scan takes first result, match-job uses confidence scoring with duration). Without reading both implementations, the spec left it ambiguous which pattern to follow. Fix: /elaborate should always read the source of any service it references to understand the actual behavior, not just the interface.
