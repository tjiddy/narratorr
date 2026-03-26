---
scope: [frontend]
files: [src/client/pages/library-import/useLibraryImport.test.ts]
issue: 133
source: review
date: 2026-03-26
---
A test that claims to exercise async deselection behavior but only checks initial state is vacuous — deleting the production logic leaves the test green. Whenever a test checks state "before" an async event and never drives the event, it proves nothing. Always: (1) drive the async condition (poll result, mutation response, timer), (2) assert the state change with waitFor, (3) confirm the test fails when the production branch is removed. For setInterval-driven behaviors, extend waitFor timeout beyond the interval.
