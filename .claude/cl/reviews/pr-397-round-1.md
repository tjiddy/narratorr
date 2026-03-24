---
skill: respond-to-pr-review
issue: 397
pr: 400
round: 1
date: 2026-03-16
fixed_findings: [F1]
---

### F1: SortDirection not derived from shared schema
**What was caught:** `BookListService` still defined its own `SortDirection = 'asc' | 'desc'` union instead of deriving it from the shared book query schema, violating AC3 and DRY-1.
**Why I missed it:** The shared schema had `sortDirection` as an inline `z.enum(['asc', 'desc'])` inside `bookListQuerySchema` — there was no named `bookSortDirectionSchema` to import (unlike `bookSortFieldSchema` which already existed as a standalone export). I imported `BookSortField` from the named export but didn't notice `SortDirection` had no equivalent named export to derive from, so I fell back to a local type.
**Prompt fix:** Add to `/implement` step 4 general rules: "When an AC says 'derive type X from shared schema' and the shared schema has the value inline (not as a named export), extract it as a named export first, then import the derived type. Don't fall back to a local type definition just because the shared module doesn't have the exact export you need."
