---
scope: [backend]
files: [src/server/services/import-orchestration.helpers.ts]
issue: 637
date: 2026-04-18
---
`createReadStream` and `createWriteStream` are on `node:fs`, NOT `node:fs/promises`. Importing them from `fs/promises` causes a compile-time error. Use `import { createReadStream, createWriteStream } from 'node:fs'` alongside `import { pipeline } from 'node:stream/promises'` for stream-based file copying.
