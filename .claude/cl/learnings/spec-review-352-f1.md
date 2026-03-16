---
scope: [type/chore]
files: []
issue: 352
source: spec-review
date: 2026-03-14
---
AC2 required happy-path + invalid-input + error-path tests for every AC item unconditionally, but the repo testing standard (`.claude/docs/testing.md:25-35`) explicitly says test-plan categories apply "where applicable." The /elaborate skill generated the AC without cross-checking it against the existing testing standard, creating a contradiction. Should have verified new testing requirements align with the established contract before writing them.
