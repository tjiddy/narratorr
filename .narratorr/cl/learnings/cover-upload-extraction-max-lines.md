---
scope: [backend]
files: [src/server/services/book.service.ts, src/server/services/cover-upload.ts]
issue: 445
date: 2026-04-09
---
`book.service.ts` is already near the 400-line `max-lines` ESLint limit (skipBlankLines: true, skipComments: true). Adding ~55 lines for `uploadCover` pushed it over. Had to extract the filesystem logic to `cover-upload.ts` and keep only validation + delegation in the service. When adding methods to large service files, check line count first and plan extraction upfront.
