---
scope: [scope/core]
files: [src/core/download-clients/transmission.ts, src/core/notifiers/slack.ts]
issue: 431
source: spec-review
date: 2026-03-17
---
Reviewer caught that the fetchWithTimeout scope contradicted itself: transmission was listed as in-scope adapter but its only timeout code (rpc()) was marked out of scope. Also described notifiers as using "AbortController" when they actually use AbortSignal.timeout(). Prevention: when defining utility scope, verify the exact mechanism each call site uses (grep for both AbortController and AbortSignal.timeout) and ensure the scope/exclusion boundaries don't contradict.
