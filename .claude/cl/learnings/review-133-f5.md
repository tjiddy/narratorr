---
scope: [frontend]
files: [src/client/App.test.tsx]
issue: 133
source: review
date: 2026-03-26
---
Every new route added to App.tsx needs a corresponding App-level test that renders the router at that path and asserts the correct page component appears. Component-level tests and link assertions in sibling components do not prove the router registration is correct. A route typo (e.g., "library-imports" vs "library-import") would still pass all page tests.
