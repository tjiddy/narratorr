---
scope: [frontend]
files: [src/client/hooks/useConnectionTest.ts]
issue: 234
date: 2026-03-31
---
Setting state to null before an async call (`setResult(null)` then `await fetch()`) causes a visible "flash" where the UI briefly shows nothing before the new result arrives. The fix is to simply not null the state — let the new result overwrite the old one directly. This pattern applies to any hook that manages async result state where the previous value is better than nothing during flight.
