---
scope: [backend]
files: [src/server/services/rename.service.test.ts]
issue: 555
source: review
date: 2026-04-14
---
When a refactoring changes observable behavior (first-author → all-authors in rename events), the existing test using `objectContaining` won't catch a regression if it doesn't assert the changed field. Always add an explicit assertion for the contract change itself, not just the surrounding fields.
