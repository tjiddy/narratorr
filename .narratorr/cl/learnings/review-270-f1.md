---
scope: [core]
files: [src/core/download-clients/nzbget.test.ts]
issue: 270
source: review
date: 2026-04-01
---
When testing a fallback branch (e.g., empty message → use code/name), the assertion must include the fallback-specific detail, not just a common prefix. `toThrow('NZBGet RPC error')` passes whether the fallback fires or not. The assertion should have been `toThrow('NZBGet RPC error: JSONRPCError (code 0)')` from the start. Root cause: wrote the assertion against the prefix rather than the full expected output of the new branch.
