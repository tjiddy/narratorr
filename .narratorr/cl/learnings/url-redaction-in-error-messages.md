---
scope: [core]
files: [src/core/utils/download-url.ts]
issue: 541
date: 2026-04-13
---
Any catch-all error branch that forwards `error.message` to the caller is a potential credential leak if the upstream includes URLs with passkeys/tokens in error text. A simple `message.replace(/https?:\/\/\S+/gi, '[redacted-url]')` is sufficient — it strips URLs without needing to parse them. The specific error-code branches above (ENOTFOUND, ECONNREFUSED, etc.) are safe because they use static strings, so the regex only needs to cover the fallthrough.
