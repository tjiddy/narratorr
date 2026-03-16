---
scope: [scope/frontend, scope/ui]
files: []
issue: 342
source: spec-review
date: 2026-03-11
---
AC used "No visual regression on ... glass styling" which violates the testing standard ("assert consequences, not implementation — don't assert CSS classes"). Acceptance criteria must describe observable user behavior, not styling implementation details. Rewrite as "controls remain visible and interactive" instead.
