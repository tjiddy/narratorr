---
scope: [scope/backend, scope/services]
files: []
issue: 357
source: spec-review
date: 2026-03-13
---
Spec review suggested adding a blast radius table listing affected test files and mock sites for a refactoring issue. The `/elaborate` subagent explored existing test coverage but didn't surface it as a structured blast-radius section in the spec.

Root cause: The elaboration skill doesn't include blast radius as a durable content category. For refactoring/chore issues that move code between files, a blast radius table (test files, mock sites, import paths that change) is valuable durable content.
