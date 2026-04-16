---
scope: [infra, testing]
files: [.claude/skills/handoff/SKILL.md, e2e/]
issue: 612
date: 2026-04-16
---
Playwright-owned folders (`e2e/**`) must be exempt from the `/handoff` coverage gate's vitest-co-location check. Every file under `e2e/` (config, fixtures, teardown, `.spec.ts`) would otherwise flag as "MISSING TEST" because none of them have a co-located `.test.ts` — vitest is not the runner for that folder. Writing vitest tests for Playwright harness code is not the fix: it creates dual-runner confusion, doesn't actually exercise the harness (which only runs under Playwright), and forces vitest.config extension. The harness is exercised end-to-end every time `pnpm test:e2e` runs; if `createRunTempDirs` or the teardown broke, the smoke test wouldn't pass. Exemption added as `grep -v '^e2e/'` in the gate's filter list.
