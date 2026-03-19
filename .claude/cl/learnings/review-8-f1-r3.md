---
scope: [scope/frontend]
files: [src/client/index.html, src/client/lib/theme-bootstrap.ts, src/client/lib/theme-bootstrap.test.ts]
issue: 8
source: review
date: 2026-03-19
---
Extracting inline HTML script logic into a tested helper module doesn't close the regression gap unless the `index.html` actually calls that helper. When the IIFE and the helper are separate code paths, tests of the helper can all pass while the production IIFE regresses silently. The full fix is to test the ACTUAL inline script: read `index.html` with `fs.readFileSync`, extract the script content via regex, and `eval()` it in the JSDOM test context under mocked `localStorage`/`window.matchMedia`. This tests the real production before-first-paint path, not a duplicate abstraction.
