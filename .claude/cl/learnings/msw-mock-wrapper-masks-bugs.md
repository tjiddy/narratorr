---
scope: [core]
files: [src/core/download-clients/qbittorrent.test.ts]
issue: 24
date: 2026-03-20
---
`HttpResponse.json('v4.6.0')` wraps the string as a JSON value (returns `"v4.6.0"` with quotes and `Content-Type: application/json`), which means `JSON.parse()` succeeds — masking bugs where the real API returns bare plain text. When the real API returns non-JSON, always use `new HttpResponse('text')` in MSW mocks to match actual wire behavior, or the test gives false confidence.
