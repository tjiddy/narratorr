---
scope: [frontend]
files: [tsconfig.json]
issue: 416
date: 2026-04-08
---
This project's tsconfig has `"types": ["node"]` without `vite/client` types, so `import.meta.env` is not typed (TS2339). Use `process.env.NODE_ENV` instead for env-conditional logic in client code — Vitest sets it to `'test'` and Vite replaces it at build time. If `import.meta.env.MODE` is ever needed, add `/// <reference types="vite/client" />` to a `.d.ts` file or add `"vite/client"` to tsconfig types.
