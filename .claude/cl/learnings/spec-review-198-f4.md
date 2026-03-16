---
scope: [scope/backend]
files: []
issue: 198
source: spec-review
date: 2026-03-12
---
Spec invented new env var names (NARRATORR_TITLE, NARRATORR_AUTHOR) when an existing script integration already uses a different namespace (NARRATORR_BOOK_TITLE, NARRATORR_BOOK_AUTHOR, NARRATORR_IMPORT_PATH). Using "etc." in AC is not testable and masked the inconsistency. When a spec introduces external-facing contracts (env vars, API fields, CLI flags), `/elaborate` must check for existing precedent in the codebase and enumerate the exact contract — no "etc." allowed.
