---
scope: [core]
files: [src/core/utils/detect-usenet-language.ts]
issue: 395
date: 2026-04-07
---
NZB `<group>` tags are simple text-only elements with no nesting or attributes — a regex `/<group>([^<]+)<\/group>/gi` is sufficient and avoids importing cheerio (which the newznab adapter uses for more complex XML). This keeps the utility dependency-free within core/utils. If NZB parsing ever needs attribute extraction, switch to cheerio.
