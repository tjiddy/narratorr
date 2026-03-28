---
scope: [scope/backend, scope/ui]
files: []
issue: 407
source: spec-review
date: 2026-03-17
---
Reviewer caught that "Frontend changes" was listed as out-of-scope while the spec simultaneously required client type and filter dropdown edits. Root cause: scope boundaries were copy-pasted from an earlier draft before the Enum Touch List was added. When adding cross-cutting enum/type changes to a spec, re-read scope boundaries to ensure they don't contradict the new requirements. A grep for mentioned file paths against the in/out-of-scope sections would catch this mechanically.
