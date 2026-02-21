---
scope: [backend]
files: [apps/narratorr/src/server/routes/crud-routes.test.ts]
issue: 157
source: review
date: 2026-02-21
---
Reviewer caught missing 400 and 404 tests across two review rounds. The spec said "shared CRUD error paths (404, 400, 500)" but I only wrote 500 tests initially — missed both validation 400s and not-found 404s. Root cause: mentally mapped "error paths" to "service throws" and skipped the other two status code categories entirely. When a spec lists status codes to cover, systematically check each verb × each status code, not just the dramatic failures. This bit us twice on the same PR.
