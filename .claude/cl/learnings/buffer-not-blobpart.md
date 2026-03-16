---
scope: [core]
files: [src/core/download-clients/qbittorrent.ts]
issue: 264
date: 2026-03-08
---
Node.js `Buffer` is not assignable to `BlobPart` in TypeScript. When creating a `Blob` from a Buffer (e.g., for multipart FormData upload), wrap it: `new Blob([new Uint8Array(buffer)])`. Using `new Blob([buffer])` directly causes a TypeScript error.
