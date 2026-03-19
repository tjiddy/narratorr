---
scope: [scope/frontend, scope/backend]
files: [src/shared/schemas/auth.ts]
issue: 3
source: spec-review
date: 2026-03-19
---
Reviewer caught that changing Zod `.min(8)` to `.min(1)` without specifying the validation message update would leave stale "at least 8 characters" copy in API 400 responses (error-handler returns Zod messages directly). The spec mentioned updating the numeric constraint but not the user-visible error string baked into it. When removing a validation rule, always check if the rule's error message is user-visible and specify the replacement message explicitly.
