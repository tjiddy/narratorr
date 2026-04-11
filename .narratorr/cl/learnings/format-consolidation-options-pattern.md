---
scope: [frontend]
files: [src/client/lib/format.ts]
issue: 487
date: 2026-04-11
---
When consolidating duplicate formatters with behavioral differences (e.g., one caller elides zero parts, another always shows both), an options object with boolean flags and a fallback string is the cleanest pattern. This avoids splitting into multiple named functions while keeping each call site's behavior explicit. The key insight: default the option to the most common behavior so most callers don't need to pass options at all.
