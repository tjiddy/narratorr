---
scope: [backend]
files: [src/server/jobs/rss.ts]
issue: 406
date: 2026-04-07
---
Extracting inline code from a function can drop it below ESLint's `max-lines-per-function` threshold, making `eslint-disable-next-line max-lines-per-function` directives unused. This causes a lint failure for "unused eslint-disable directive." Always check for now-unnecessary disable directives after reducing function size.
