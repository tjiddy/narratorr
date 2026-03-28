---
scope: [scope/backend, scope/services]
files: []
issue: 436
source: spec-review
date: 2026-03-17
---
Reviewer caught that AC1 ("ImportService only handles file import + DB state") contradicted the spec's own test plan which included queue admission and torrent removal tests. The AC was written as a broad aspiration rather than a precise boundary statement. Root cause: didn't reconcile the AC wording against the full list of methods on the service after deciding queue/torrent stay. Fix: after writing ACs, cross-check each one against the actual method inventory of the class being refactored.