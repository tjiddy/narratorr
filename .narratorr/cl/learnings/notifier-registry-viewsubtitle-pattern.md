---
scope: [frontend]
files: [src/shared/notifier-registry.ts, src/shared/notifier-registry.test.ts]
issue: 453
date: 2026-04-10
---
Notifier registry `viewSubtitle` functions are pure data transforms with no side effects — changes to their return values are display-only and have zero blast radius beyond co-located tests and the card component test. When extracting hostnames from URLs, `new URL()` constructor throws on invalid input, so always wrap in try/catch with a fallback. The `||` fallback pattern used elsewhere in the registry doesn't handle invalid URLs (only empty strings).
