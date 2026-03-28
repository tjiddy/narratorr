---
scope: [backend]
files: [apps/narratorr/src/server/services/download.service.test.ts]
issue: 239
date: 2026-02-25
---
Bug-documenting tests (from #235 UAT hardening) make bug fixes nearly trivial — the test already has the exact mock setup, you just flip the assertions from "broken behavior" to "fixed behavior". When writing bug-documenting tests, include the full mock chain so the fix PR is a test edit, not a test creation.
