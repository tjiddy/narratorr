---
scope: [scope/frontend]
files: []
issue: 5
source: spec-review
date: 2026-03-19
---
Spec referenced `src/client/pages/settings/components/CredentialsSection.tsx` but the actual file is `src/client/pages/settings/CredentialsSection.tsx` (no `components/` subdirectory). The spec was written from memory/assumption about folder structure rather than verifying with `git ls-files`. Always verify file paths against the repo before including them in Technical Notes.
