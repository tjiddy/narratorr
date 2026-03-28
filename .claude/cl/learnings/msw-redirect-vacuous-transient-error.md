---
scope: [core]
files: [src/core/metadata/audible.test.ts, src/core/metadata/audnexus.test.ts]
issue: 174
date: 2026-03-28
---
When MSW intercepts a fetch with no redirect:manual and returns a 3xx, the browser fetch tries to follow the redirect to the Location URL. If MSW has no handler for that URL, it throws an "onUnhandledRequest" error — which gets caught by the provider try/catch and wrapped as a TransientError. This means redirect tests written as rejects.toThrow(TransientError) pass before implementation for the wrong reason. Always assert on the error message content (e.g., rejects.toThrow(/redirect/i)) so the test distinguishes real redirect protection from MSW noise.
