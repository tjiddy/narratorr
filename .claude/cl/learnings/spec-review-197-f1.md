---
scope: [scope/core, scope/backend]
files: [packages/core/src/download-clients/sabnzbd.ts]
issue: 197
source: spec-review
date: 2026-02-23
---
Reviewer caught that the SABnzbd adapter uses `new URL('/api', baseUrl)` which resolves the absolute path `/api` against the origin, dropping any base path in `baseUrl`. The spec's test plan assumed urlBase would be preserved when baked into baseUrl, which is incorrect per URL resolution rules.

Gap: The elaborate pass noted "SABnzbd uses `new URL('/api', baseUrl)` which replaces the path — urlBase must be baked into baseUrl itself" but didn't follow through on the implication — baking it into baseUrl doesn't work because `new URL` with an absolute path discards the base's path. Should have tested the actual URL resolution behavior rather than assuming.

Prevention: When a spec involves modifying URL construction, verify the exact behavior of the URL API with the proposed change, not just the general approach.
