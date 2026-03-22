---
scope: [frontend, backend]
files: [src/client/lib/api/activity.ts]
issue: 57
source: review
date: 2026-03-22
---
When the server-side type makes a new field required (DownloadWithBook.indexerName: string | null), the client DTO should mirror it as required — not optional. Using `?: string | null` instead of `: string | null` weakens the contract and hides regressions where the field is dropped entirely. The test for this is: does TypeScript catch a consumer that constructs a Download object without indexerName? With `?:` it does not; with `:` it does. Always align client DTO field presence with the server guarantee when the spec says the field is always-present.
