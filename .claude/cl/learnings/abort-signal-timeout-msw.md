---
scope: [core, backend]
files: [packages/core/src/notifiers/telegram.ts, packages/core/src/notifiers/slack.ts]
issue: 278
date: 2026-03-06
---
`AbortSignal.timeout(10_000)` works with MSW in vitest for testing timeout behavior — MSW's delayed handler (`await new Promise(r => setTimeout(r, 15_000))`) triggers the DOMException with `name: 'TimeoutError'`. The timeout test needs a longer vitest timeout (15s) since it actually waits for the signal to fire. Pattern: `it('...', async () => { ... }, 15_000)`.
