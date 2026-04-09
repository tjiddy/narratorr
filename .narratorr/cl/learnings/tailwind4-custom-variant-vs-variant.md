---
scope: [frontend]
files: [src/client/index.css]
issue: 450
date: 2026-04-09
---
Tailwind 4 supports both `@variant` and `@custom-variant` for defining custom variants, but `@custom-variant` is the documented directive. The existing `@variant dark` in this codebase works because Tailwind 4.2.1 internally aliases `@variant` → `@custom-variant` (confirmed in `dist/lib.js`). New custom variants should use `@custom-variant` to match official docs. This caused a spec review round-trip when the spec originally used `@variant`.
