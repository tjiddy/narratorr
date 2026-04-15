---
scope: [core]
files: [src/core/download-clients/sabnzbd.test.ts]
issue: 565
source: review
date: 2026-04-15
---
When a new code path reimplements transport logic (timeout/auth/HTTP error handling) rather than reusing an existing helper, each branch needs its own test — even if the logic looks identical to existing branches tested elsewhere. Different call sites = different code paths = separate coverage needed. The existing GET-based `request()` tests don't prove the POST-based `addDownloadFromBytes()` branches work.
