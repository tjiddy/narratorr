---
scope: [backend]
files: [eslint.config.js]
issue: 552
date: 2026-04-14
---
ESLint `max-lines` rule is configured with `skipBlankLines: true, skipComments: true`. Raw `wc -l` line counts overstate violations — a 478-line file may have only 399 code lines and pass ESLint. Always check the ESLint config before estimating extraction targets, or run `npx eslint <file>` directly to confirm actual violations.
