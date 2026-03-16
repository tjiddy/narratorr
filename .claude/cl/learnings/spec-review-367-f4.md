---
scope: [scope/frontend]
files: []
issue: 367
source: spec-review
date: 2026-03-16
---
AC said "suggestion count displayed in hero section" but didn't define whether it was total (from API stats) or filtered (client-side visible count). The test plan said it "updates when filter is applied" which implied filtered count, but the AC was ambiguous. Any count displayed in the UI must specify its source of truth (API field vs client-side derivation) so the test plan and AC are unambiguous.
