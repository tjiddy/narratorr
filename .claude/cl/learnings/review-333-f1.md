---
scope: [backend]
files: [src/server/jobs/version-check.ts]
issue: 333
source: review
date: 2026-03-10
---
Reviewer caught that `html_url` wasn't validated before caching — only `tag_name` was checked. A malformed GitHub payload with `tag_name` but missing `html_url` would cache a broken empty release URL. Missed because the `|| ''` fallback felt safe but actually masked bad data. Lesson: validate ALL required fields from external APIs before caching, not just the primary key field.
