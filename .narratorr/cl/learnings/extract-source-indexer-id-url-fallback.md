---
scope: [backend]
files: [src/server/routes/prowlarr-compat.ts]
issue: 200
date: 2026-03-29
---
`extractSourceIndexerId` has a URL constructor try/catch fallback at line 77. When URL() throws, it uses the raw baseUrl string as pathname for regex matching. To test this, pass a string like `not-a-url/42/` — the URL constructor throws, fallback uses the raw string, and regex finds `/42/` → returns 42. A string with no `/(\d+)` pattern returns null.
