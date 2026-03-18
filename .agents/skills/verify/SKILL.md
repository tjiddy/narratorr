---
name: verify
description: Run quality gates (lint, test, typecheck, build) and return a structured
  pass/fail summary. Use when user says "run checks", "verify", "quality gates", or
  invokes /verify.
---

# /verify — Run quality gates

Run: `node scripts/verify.ts`

Display the output to the user.

On success the script outputs one line: `VERIFY: pass (N suites, M tests)`.
On failure it outputs only the failing gates with error details.
