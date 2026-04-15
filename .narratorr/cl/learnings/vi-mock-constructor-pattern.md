---
scope: [backend]
files: [src/core/import-lists/registry.test.ts]
issue: 563
date: 2026-04-15
---
When mocking ES module classes for constructor-argument assertions, `vi.fn().mockImplementation(() => ...)` creates a plain function that fails with `new`. Use `vi.fn(function(this) { return Object.assign(this, props); })` to make the mock constructable. The `function` keyword (not arrow) gives `this` binding needed by `new`.
