---
scope: [frontend]
files: [src/client/pages/library-import/useLibraryImport.ts]
issue: 133
source: review
date: 2026-03-26
---
Client-side duplicate rechecks must use the EXACT same comparison logic as the server. The backend's findDuplicate() uses exact title equality (===), not case-insensitive. Using .toLowerCase() on both sides is more permissive in one direction and more restrictive in another, causing UI/backend mismatch. When implementing client-side recheck of a server constraint, read the server code and copy the comparison precisely.
