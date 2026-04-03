---
scope: [backend]
files: [src/server/routes/book-preview.ts]
issue: 320
source: review
date: 2026-04-03
---
createReadStream() doesn't throw synchronously for missing files — it emits an 'error' event on the stream, which Fastify handles as a 500. To satisfy a 404 error contract for file-disappearance races, use fs.promises.open() before streaming to verify the file is still accessible. The open() call catches the race window between stat() and stream creation. Self-review missed this because the test accepted 500 as valid (vacuous assertion).
