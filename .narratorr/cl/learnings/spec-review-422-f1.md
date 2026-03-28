---
scope: [scope/backend, scope/services]
files: []
issue: 422
source: spec-review
date: 2026-03-17
---
AC2 said "no string matching in activity and event-history routes" but the scope boundary excluded the retry route, which also string-matches. The AC was too broad for the scope. Root cause: wrote AC2 as a blanket "all routes" statement without cross-referencing which routes actually exist in each file and checking each against scope boundaries. Fix: when writing ACs that say "all X do Y", enumerate the specific X items and verify each is in scope.
