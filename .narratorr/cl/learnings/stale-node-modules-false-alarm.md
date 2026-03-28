---
scope: [backend]
files: [package.json, node_modules/]
issue: 383
date: 2026-03-15
---
Stale `node_modules` can cause test failures that look like Node version incompatibility. When tests fail with "Invalid Chai property" or "Cannot find module 'ajv/dist/jtd'", try `rm -rf node_modules && pnpm install --frozen-lockfile` before blaming the Node version. This session wasted significant time diagnosing a "Node 24 incompatibility" that turned out to be a corrupted pnpm store.
