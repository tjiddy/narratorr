---
scope: [scope/core]
files: [src/core/utils/fetch-with-timeout.ts, src/server/utils/enrich-usenet-languages.ts]
issue: 395
source: review
date: 2026-04-07
---
Reviewer flagged that the NZB fetch path used raw `fetch()` + `AbortSignal.timeout()` instead of the shared `fetchWithTimeout()` wrapper. This creates inconsistent error behavior — `fetchWithTimeout` handles redirects and maps network errors, which raw `fetch` does not.

Root cause: the spec mentioned `fetchWithTimeout` as an available utility but the implementation used raw fetch for brevity, missing the behavioral contract.

Prevention: when the plan identifies shared utilities for HTTP (fetchWithTimeout), enforce their use in all HTTP paths — not just adapter code.
