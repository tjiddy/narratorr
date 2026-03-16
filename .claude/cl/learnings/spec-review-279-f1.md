---
scope: [scope/frontend, scope/backend]
files: [src/client/pages/settings/SystemSettings.tsx]
issue: 279
source: spec-review
date: 2026-03-10
---
Spec proposed adding new sections to an existing page (/settings/system) without mentioning the existing backup/restore functionality already there. The elaborate pass didn't check what currently renders on the target page. Always read the current page component before writing ACs that expand it — existing features must be explicitly preserved or relocated.
