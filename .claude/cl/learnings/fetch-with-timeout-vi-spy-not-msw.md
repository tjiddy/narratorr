---
scope: [core]
files: [src/core/utils/fetch-with-timeout.test.ts]
issue: 23
date: 2026-03-20
---
`fetchWithTimeout` utility tests use `vi.spyOn(globalThis, 'fetch')` directly (not MSW), because the utility is a thin wrapper around native `fetch` — MSW intercepts at the network layer and doesn't give direct control over response status in the same way `new Response(null, { status: 302 })` does. Adapter-level tests (NZBGet, Slack) use MSW because they test real HTTP flows through the adapter logic. This distinction matters: utility tests mock the primitive, caller tests mock the network.
