---
scope: [type/chore]
files: []
issue: 352
source: spec-review
date: 2026-03-14
---
AC5 required skill files to "parse correctly" but no parser exists for `.claude/skills/*.md` files, and `scripts/verify.ts` doesn't cover them. The AC referenced a capability that doesn't exist in the repo. Should have verified that validation mechanisms exist before writing AC that depend on them.
