---
scope: [backend]
files: [src/shared/schemas/auth.ts]
issue: 145
date: 2026-03-26
---
When applying `.trim()` to Zod string fields, password fields must be explicitly excluded — passwords are user secrets where leading/trailing spaces may be intentional. The CLAUDE.md gotcha (ZOD-1) says "add .trim() to all .min(1) string fields" but doesn't explicitly carve out passwords; the exception must be derived from first principles. Always check for security-sensitive fields (passwords, API keys, tokens) before applying blanket .trim() fixes.
