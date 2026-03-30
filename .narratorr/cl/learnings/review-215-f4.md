---
scope: [core]
files: [src/shared/schemas/settings/library.ts]
issue: 215
source: review
date: 2026-03-30
---
Reviewer caught that libraryFormSchema used inline token-error messages instead of the exported FOLDER_TOKEN_MSG/FILE_TOKEN_MSG constants. The title messages were using shared constants but the token messages were overlooked — partial deduplication is worse than no deduplication because it creates a false sense of completion. When deduplicating message strings, grep for ALL instances of each message in the target file, not just the first few.
