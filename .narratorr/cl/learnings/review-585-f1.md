---
scope: [backend]
files: [src/server/utils/sanitize-log-url.ts]
issue: 585
source: review
date: 2026-04-15
---
Reviewer caught that the catch-path comment cited `ftp:` as an example of an input reaching the fallback, but `new URL('ftp:...')` parses successfully. When writing rationale comments for error/catch paths, verify which inputs actually trigger the path by checking the language spec or running the code — don't assume from the contract header. The existing test file (`sanitize-log-url.test.ts:67-69`) already showed the real catch-path input (`not-a-url`).
