---
scope: [backend]
files: [src/server/routes/library-scan.ts]
issue: 446
date: 2026-04-09
---
Fastify route factory functions (like `libraryScanRoutes`) that register multiple endpoints easily hit ESLint's `max-lines-per-function` (150) and `complexity` (15) limits. When adding a new endpoint with non-trivial logic, extract the handler body into standalone helper functions outside the factory. This keeps the factory as a thin wiring layer (route path + schema + handler delegation) and keeps each helper under the complexity ceiling independently.
