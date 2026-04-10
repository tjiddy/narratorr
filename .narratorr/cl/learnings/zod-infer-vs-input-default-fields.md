---
scope: [frontend]
files: [src/shared/schemas/search.ts, src/client/lib/api/search.ts]
issue: 412
date: 2026-04-10
---
`z.infer<typeof schema>` gives the OUTPUT type where `.default()` fields are required, but client callers need the INPUT type (`z.input<typeof schema>`) where those fields are optional. When replacing an inline param type with a Zod-derived type, always check for `.default()` fields — using `z.infer` will break callers that omit them. Export both `z.infer` (for server post-parse) and `z.input` (for client pre-send) types.
