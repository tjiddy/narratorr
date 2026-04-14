---
scope: [backend]
files: [src/server/services/auth.service.ts]
issue: 545
date: 2026-04-14
---
`timingSafeEqual` throws if Buffer lengths differ — always add a length check guard before calling it. The existing session cookie verification pattern at auth.service.ts:304-311 demonstrates this correctly, but the API key comparison at :264 was missed because it predated the session work. When writing timing-safe comparisons, check for all call sites in the same file.
