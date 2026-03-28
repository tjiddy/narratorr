---
scope: [scope/backend]
files: []
issue: 406
source: spec-review
date: 2026-03-17
---
Reviewer caught inconsistent terminology — the spec alternated between `accepted` (natural language) and `added` (the actual DB status literal). Prevention: when referencing DB enum values in ACs and test plans, always use the exact persisted literal. Define a glossary mapping once if a natural-language alias is needed, but default to the DB literal everywhere.