---
scope: [backend]
files: [src/shared/schemas/settings/create-mock-settings.ts]
issue: 392
date: 2026-03-15
---
When implementing deep-merge for test fixtures, checking `overrideVal === undefined` instead of truthiness is critical. JavaScript's `||` and `??` operators handle `0`, `false`, and `''` differently — a deep-merge that uses `overrideVal || default` would silently replace valid falsy overrides like `minFreeSpaceGB: 0` or `enabled: false` with defaults, causing subtle test failures.
