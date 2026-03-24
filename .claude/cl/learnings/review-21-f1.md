---
scope: [backend]
files: [src/server/plugins/security-plugins.ts, src/server/index.ts, src/server/plugins/csp-nonce-strip.test.ts, src/server/plugins/helmet.test.ts]
issue: 21
source: review
date: 2026-03-20
---
Test apps that manually inline plugin registration can silently diverge from production wiring. When tests build their own `app.register(helmet)` + `app.register(plugin)` in `createApp()`, the tests pass even if `index.ts` forgets to register one of them. Fix: extract the registration into a shared `registerSecurityPlugins(app, isDev)` helper called by both `index.ts` and test helpers — divergence becomes impossible because they call the same function.
