---
scope: [frontend, infra]
files: [vite.config.ts, src/server/server-utils.ts]
issue: 284
date: 2026-03-09
---
Vite's `base` option is baked into the build output at build time — asset references in HTML and JS use the base path. For Docker images that need to work with any URL_BASE at runtime (without rebuilding), use `base: './'` for relative asset paths. Then inject the URL_BASE at runtime via server-side HTML modification (injecting a `<script>` tag before `</head>`). This requires `'unsafe-inline'` in CSP scriptSrc.
