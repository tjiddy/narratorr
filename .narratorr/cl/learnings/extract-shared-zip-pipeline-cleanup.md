---
scope: [backend]
files: [src/server/services/backup.service.ts]
issue: 313
date: 2026-04-03
---
When extracting shared logic from a method that has try/catch cleanup (like `processRestoreUpload`), the new private helper must own its own cleanup. The original method cleaned up `tempDir` in its outer catch, but after extraction into `extractDbFromZip`, that catch no longer has access to `tempDir`. The helper must wrap its own try/catch to clean up the temp directory on zip parsing errors — otherwise temp dirs leak on non-zip input.
