---
scope: [backend]
files: [src/server/services/blacklist.service.test.ts]
issue: 411
source: review
date: 2026-04-08
---
When testing OR logic across two parameters, test both sides independently: (hash-hit, guid-miss) AND (hash-miss, guid-hit). A single test with one side matching proves nothing about the other branch. The existing test only proved hash-hit with guid-miss, missing the symmetric case where guid-hit with hash-miss is the important usenet scenario this bug fix was about.
