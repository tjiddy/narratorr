---
scope: [frontend]
files: [src/client/pages/discover/SuggestionCard.tsx]
issue: 487
source: review
date: 2026-04-11
---
When the AC says "remove local helper from file X," the wrapper must be fully inlined at the call site — not just updated to call the shared formatter. The reviewer caught that `formatDurationFromSeconds` still existed as a local function even though its body was updated to use the shared `formatDurationMinutes`. The implementation step should have grepped for the function definition, not just the import.
