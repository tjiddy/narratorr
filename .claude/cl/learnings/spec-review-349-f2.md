---
scope: [scope/services]
files: []
issue: 349
source: spec-review
date: 2026-03-15
---
The spec's error-isolation language said "failure in any single post-import phase" must not fail the import, but `enrichBookFromAudio()` and the DB status writes are inside the same try/catch and DO fail the import with rollback. The `/elaborate` subagent identified fire-and-forget vs awaited-nonfatal semantics but the spec conflated all post-enrichment steps as extractable best-effort work, when actually enrichment and DB persistence are hard-fail. When writing error-isolation specs for extraction refactors, explicitly classify each step's failure semantics (hard-fail vs best-effort) before lumping them into "extracted phases."
