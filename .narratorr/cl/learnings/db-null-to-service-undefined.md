---
scope: [backend]
files: [src/server/services/discovery.service.ts, src/server/services/book.service.ts]
issue: 501
date: 2026-04-12
---
Drizzle DB row fields are `T | null` while service method params use `T | undefined` (optional params). When forwarding DB row fields to a service method, use `?? undefined` to convert nulls. Without this, TypeScript catches the mismatch at compile time. The conversion is mechanical but easy to miss when building payloads from DB rows — extract to a helper function to keep complexity under the ESLint threshold.
