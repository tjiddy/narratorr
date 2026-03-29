---
scope: [backend, core]
files: [src/core/metadata/audnexus.test.ts]
issue: 198
date: 2026-03-29
---
MSW default handlers don't validate query parameters — they match on path only. To test that query params (like `?region=uk`) are actually sent, capture `request.url` inside the MSW handler callback via a `let capturedUrl` variable, then assert on it after the call. This is the only reliable way to verify query param presence without modifying production code.
