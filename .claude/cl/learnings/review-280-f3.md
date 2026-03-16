---
scope: [scope/backend, scope/api]
files: [src/server/routes/system.ts]
issue: 280
source: review
date: 2026-03-10
---
The restore upload route piped all input through unzipper.Parse() and caught errors as 500. Non-zip files (text, corrupted archives) threw parser errors that should be client errors (400). Root cause: the catch block didn't distinguish between parser errors (invalid input) and server errors (disk/IO failures). Prevention: when using streaming parsers, always check error messages for format/validation failures and map them to 4xx responses.
