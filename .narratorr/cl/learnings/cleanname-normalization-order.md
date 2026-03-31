---
scope: [backend, core]
files: [src/server/services/library-scan.service.ts]
issue: 235
date: 2026-03-31
---
When adding new normalization steps to `cleanName()`, the order matters: leading-number stripping must happen BEFORE dot-to-space conversion, because the leading-number regex relies on literal dots (`01. Title`). Converting dots to spaces first breaks backward compatibility. This is a subtle ordering dependency that isn't obvious from reading the regex in isolation.
