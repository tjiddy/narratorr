---
scope: [frontend]
files: [src/client/hooks/useCrudSettings.ts]
issue: 146
date: 2026-03-26
---
When a god hook spreads a sub-object (`return { ...state, ...connectionTest, ... }`), grouping means passing the sub-object directly (`tests: connectionTest`), not destructuring and re-structuring. This way the caller accesses `tests.testingId` etc. without any blast radius on the internal shape of `connectionTest`. Don't destructure a spread just to re-add keys individually — pass the original object as the group value.
