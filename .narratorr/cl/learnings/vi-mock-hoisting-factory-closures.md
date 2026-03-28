---
scope: [frontend]
files: [src/client/App.test.tsx]
issue: 430
date: 2026-03-18
---
vi.mock() factory functions are hoisted above all variable declarations. Variables defined before the mock call (const MockIcon = ...) are undefined when the mock factory runs. Solution: define all mock values inside the factory function itself, or use vi.hoisted() to explicitly hoist variables.
