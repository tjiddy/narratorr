---
scope: [infra, backend]
files: [scripts/tsup-inject.test.ts, src/server/utils/version.ts]
issue: 67
date: 2026-03-24
---
`scripts/tsup-inject.test.ts` can only inspect bundle text (e.g., assert a string literal is present in `dist/server/index.js`) — it cannot call exported functions from the built artifact because `src/server/index.ts` calls `main()` at module load, which starts the full server. For runtime behavior proof from the built image, use the Docker smoke test to hit `/api/health` (no auth required) and assert the response fields.
