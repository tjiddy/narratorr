---
scope: [frontend]
files: [apps/narratorr/src/client/components/AddBookPopover.tsx]
issue: 267
source: review
date: 2026-03-06
---
Popover that copies async query data into local state on open has a race: if the query resolves *after* opening, state stays stale. The derived state pattern (`override ?? queryDefault ?? fallback`) eliminates the race entirely — no effect, no sync timing, no ref tracking. Prefer derived values over copying query data into state when the data feeds form defaults.
