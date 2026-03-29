---
scope: [frontend]
files: [src/client/index.css, src/client/pages/settings/*.tsx, src/client/components/settings/*.tsx]
issue: 202
date: 2026-03-29
---
When doing bulk CSS class replacements across 20+ files, order sed patterns from most-specific to least-specific to avoid partial matches (e.g., `focus:ring-primary/50` before `focus:ring-primary`). The focus-ring utility uses `focus-visible:ring-*` (not `focus:`), so the replacement changes behavior from always-visible to keyboard-only focus rings — this is intentional for a11y.
