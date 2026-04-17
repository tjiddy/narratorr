---
scope: [infra]
files: [e2e/tests/critical-path/manual-import.spec.ts]
issue: 616
date: 2026-04-17
---
Playwright uses `page.getByPlaceholder()`, not `page.getByPlaceholderText()`. The latter is a Testing Library API (used in vitest component tests), not a Playwright locator. This mismatch causes a TypeScript error that only surfaces during `pnpm typecheck`, not during test authoring.
