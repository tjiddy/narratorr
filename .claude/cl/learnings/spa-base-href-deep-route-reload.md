---
scope: [frontend, backend]
files: [src/server/server-utils.ts, vite.config.ts]
issue: 10
date: 2026-03-19
---
When Vite builds with `base: './'`, all asset references in the emitted HTML are relative (e.g., `./assets/index-xxx.js`). On a deep-route force-reload (e.g., `/settings/security`), the browser resolves these relative to the current path, requesting `/settings/assets/...` (404) instead of `/assets/...`. The fix is to inject `<base href="/">` (or `<base href="/<urlBase>/">` for prefixed deployments) immediately after `<head>` in `sendIndexHtml()` — this redirects all relative URL resolution to the correct base without touching Vite config. Do NOT change `base: './'` in vite.config.ts; it is intentional for Docker portability.
