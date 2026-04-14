---
scope: [core]
files: [src/core/utils/chapter-resolver.ts]
issue: 546
date: 2026-04-14
---
When removing a function, always check if its removal leaves unused imports. `getDiscFolder` was the only consumer of `dirname` from `node:path` — removing the function without removing the import caused a lint failure on the first verify pass. Scan import statements after each function removal.
