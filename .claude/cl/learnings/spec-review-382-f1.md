---
scope: [scope/backend]
files: [src/server/index.ts, src/server/server-utils.ts]
issue: 382
source: spec-review
date: 2026-03-15
---
Spec proposed removing `'unsafe-inline'` from CSP without checking what inline scripts currently exist. The `window.__NARRATORR_URL_BASE__` injection in `server-utils.ts:20` uses an inline `<script>` tag — removing `'unsafe-inline'` would regress non-root URL_BASE deployments. Root cause: `/elaborate` didn't trace the CSP dependency chain to find existing inline script usage. When a spec proposes removing a security relaxation, always verify what code currently depends on it.
