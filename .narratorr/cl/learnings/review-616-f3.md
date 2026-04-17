---
scope: [core, infra]
files: [src/core/metadata/audible.ts, src/core/metadata/audible.test.ts]
issue: 616
source: review
date: 2026-04-17
---
When modifying a class field that multiple methods use (like `baseUrl` replacing the hardcoded `https://api.audible${tld}` at 3 call sites), tests must cover ALL affected call sites — not just the first one verified. The initial tests only proved the override for `searchBooks()` but left `test()` and `getBook()` unproven. A regression where one site was missed would pass the suite. Rule: count the changed call sites, write one assertion per site.
